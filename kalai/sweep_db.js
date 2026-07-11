/**
 * Sweep over DB-backed market_data — find highest-WR config
 */
'use strict';
const { Client } = require('pg');
const { RSI, StochasticRSI } = require('technicalindicators');

const PG_DSN = process.env.PG_DSN || 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const SYMBOL = process.env.BT_SYMBOL || 'BTCUSDT';
const INTERVAL = process.env.BT_INTERVAL || '4h';
const LIMIT = parseInt(process.env.BT_LIMIT || '2400', 10);
const LEVERAGE = 5, TAKER_FEE = 0.0004, FIB_LOOKBACK = 120;
const MIN_RISK = 1, RISK_PCT = 2, CAPITAL = 20;

function fibLevels(h,l){const r=h-l;return [0,0.236,0.382,0.5,0.618,0.786,1.0].reduce((a,f)=>{a[f]=h-r*f;return a;},{});}
function swingHL(c,lb){const s=c.slice(-lb);return{high:Math.max(...s.map(x=>x.high)),low:Math.min(...s.map(x=>x.low))};}
function nearFib(p,f,t){for(const[k,v]of Object.entries(f)){if(Math.abs(p-v)/v<t)return parseFloat(k);}return null;}
function volS(c,i,p=20){const s=c.slice(Math.max(0,i-p),i);const a=s.reduce((x,y)=>x+y.volume,0)/s.length;return c[i].volume/a;}

function bt(cd,cfg){
  let cap=CAPITAL,pos=null,tr=[],cl=0,paused=0,li=250;
  for(let i=250;i<cd.length;i++){li=i;const c=cd[i],p=c.close,h=c.high,l=c.low;
    if(pos){
      if(pos.side==='LONG'){const pp=(p-pos.entry)/pos.entry*100;if(pp>=cfg.ta&&p>pos.best){pos.best=p;pos.sl=Math.max(pos.sl,p*(1-cfg.td/100));}if(l<=pos.sl){const e=pos.sl,pc=(e-pos.entry)/pos.entry,fee=pos.qty*LEVERAGE*TAKER_FEE*2,pnl=pos.qty*pc*LEVERAGE-fee;cap+=pnl;if(pnl<=0){cl++;if(cl>=2)paused=li+12;}else cl=0;tr.push(pnl);pos=null;}}
      else{const pp=(pos.entry-p)/pos.entry*100;if(pp>=cfg.ta&&p<pos.best){pos.best=p;pos.sl=Math.min(pos.sl,p*(1+cfg.td/100));}if(h>=pos.sl){const e=pos.sl,pc=(pos.entry-e)/pos.entry,fee=pos.qty*LEVERAGE*TAKER_FEE*2,pnl=pos.qty*pc*LEVERAGE-fee;cap+=pnl;if(pnl<=0){cl++;if(cl>=2)paused=li+12;}else cl=0;tr.push(pnl);pos=null;}}
    }
    if(!pos&&i>=paused){const v=volS(cd,i);if(v>=cfg.volMin){const cl2=cd.slice(0,i+1).map(x=>x.close);const r=RSI.calculate({values:cl2,period:14});const rsi=r[r.length-1];const st=StochasticRSI.calculate({values:cl2,rsiPeriod:14,stochasticPeriod:14,kPeriod:3,dPeriod:3});const sk=st[st.length-1].k;const sh=swingHL(cd.slice(0,i+1),FIB_LOOKBACK);const f=fibLevels(sh.high,sh.low);const nl=nearFib(p,f,cfg.fibTol);let sig='SKIP';if(nl!==null&&[0,0.236,0.382,0.5,0.618].includes(nl)&&rsi<cfg.rsiMax&&sk<cfg.stochMax)sig='LONG';else if(nl!==null&&[1.0,0.786,0.618,0.5].includes(nl)&&rsi>(100-cfg.rsiMax)&&sk>(100-cfg.stochMax))sig='SHORT';if(sig!=='SKIP'){const qty=Math.max(cap*(RISK_PCT/100),MIN_RISK);const sl=sig==='LONG'?p*(1-cfg.slPct/100):p*(1+cfg.slPct/100);pos={side:sig,entry:p,qty,sl,best:p};}}}}
  const w=tr.filter(t=>t>0).length;return{n:tr.length,wr:tr.length?+(w/tr.length*100).toFixed(1):0,pnl:+tr.reduce((a,b)=>a+b,0).toFixed(2)};
}

(async()=>{
  const pg=new Client({connectionString:PG_DSN});await pg.connect();
  const r=await pg.query('SELECT ts,open,high,low,close,volume FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3',[SYMBOL,INTERVAL,LIMIT]);
  await pg.end();
  const cd=r.rows.reverse().map(x=>({ts:new Date(x.ts).getTime(),open:x.open,high:x.high,low:x.low,close:x.close,volume:x.volume}));
  console.log(`${SYMBOL} ${INTERVAL}: ${cd.length} candles loaded`);
  const res=[];
  for(const rsiMax of[35,40,45])for(const stochMax of[25,30,35])for(const slPct of[0.8,1.0,1.5])for(const ta of[0.8,1.2])for(const td of[0.5,0.8])for(const volMin of[1.3,1.5])for(const fibTol of[0.008,0.012]){
    const cfg={rsiMax,stochMax,slPct,trailActivate:ta,trailDist:td,volMin,fibTol};
    res.push({cfg,...bt(cd,cfg)});
  }
  res.sort((a,b)=>b.wr-a.wr);
  const good=res.slice(0,15);
  require('fs').writeFileSync('sweep_result.json', JSON.stringify({total:res.length, maxN:Math.max(...res.map(r=>r.n)), top:good}, null, 2));
  console.log('DONE configs='+res.length+' good='+good.length);
})().catch(e=>{console.error(e.message);process.exit(1);});
