const { Client } = require('pg');
const fs = require('fs');
const bt = fs.readFileSync(__dirname + '/backtest_tick.js', 'utf8');
const m = bt.match(/PG_DSN = process\.env\.PG_DSN \|\| '([^']+)'/);
const PG_DSN = m ? m[1] : process.env.PG_DSN;
const SL = 1.0, TD = 0.15, FEE = 0.0004, CAPITAL = 20, RISK = Math.max(CAPITAL * 0.02, 1);
const notional = RISK / (SL / 100);
const fee = notional * FEE * 2;

function emaArr(closes, p) { const k = 2/(p+1), e=[closes[0]]; for(let i=1;i<closes.length;i++)e.push(closes[i]*k+e[i-1]*(1-k)); return e; }
function smaArr(closes,p){const e=[];for(let i=0;i<closes.length;i++){if(i<p-1){e.push(null);continue;}let s=0;for(let j=i-p+1;j<=i;j++)s+=closes[j];e.push(s/p);}return e;}
function stdArr(closes,p,ma){const e=[];for(let i=0;i<closes.length;i++){if(i<p-1){e.push(null);continue;}let s=0;for(let j=i-p+1;j<=i;j++)s+=(closes[j]-ma[i])**2;e.push(Math.sqrt(s/p));}return e;}

function backtest(cd, strat, p1, p2) {
  let w=0,l=0,pnl=0;
  const c=cd.map(x=>x.close),h=cd.map(x=>x.high),lw=cd.map(x=>x.low),o=cd.map(x=>x.open);
  const ema1=emaArr(c,p1),ema2=emaArr(c,p2);
  const sma=smaArr(c,p1),sd=stdArr(c,p1,sma);
  const up=emaArr(c,50),up4=emaArr(c,200);
  for(let i=Math.max(p2,200)+1;i<cd.length;i++){
    let side=null,entry=null;
    if(strat==='ema_cross'){
      if(ema1[i-1]<=ema2[i-1]&&ema1[i]>ema2[i]&&c[i]>ema1[i]){side='L';entry=c[i];}
      else if(ema1[i-1]>=ema2[i-1]&&ema1[i]<ema2[i]&&c[i]<ema1[i]){side='S';entry=c[i];}
    } else if(strat==='bb_break'){
      const mid=sma[i],sdv=sd[i];if(!mid)continue;const u=mid+2*sdv,d=mid-2*sdv;
      if(c[i]>u&&c[i-1]<=u){side='L';entry=c[i];}
      else if(c[i]<d&&c[i-1]>=d){side='S';entry=c[i];}
    } else if(strat==='trend_pull'){
      const bull=up4[i]>up4[i-1];
      if(bull&&lw[i]<=ema1[i]&&c[i]>ema1[i]){side='L';entry=c[i];}
      else if(!bull&&h[i]>=ema1[i]&&c[i]<ema1[i]){side='S';entry=c[i];}
    }
    if(!side)continue;
    const slc=side==='L'?entry*(1-SL/100):entry*(1+SL/100);
    const tpl=side==='L'?entry*(1+SL/100):entry*(1-SL/100);
    let tr=false;
    for(let j=i+1;j<Math.min(i+600,cd.length);j++){
      const hj=h[j],lj=lw[j],cj=c[j];
      if(!tr){if(side==='L'?hj>=tpl:lj<=tpl){tr=true;continue;}}
      if(tr){const tpN=side==='L'?cj*(1-TD/100):cj*(1+TD/100);if(side==='L'?lj<=tpN:hj>=tpN){const pp=side==='L'?(tpN-entry)/entry*100:(entry-tpN)/entry*100;pnl+=notional*(pp/100)-fee;if(pp>0)w++;else l++;break;}}
      else{if(side==='L'?lj<=slc:hj>=slc){const pp=side==='L'?(slc-entry)/entry*100:(entry-slc)/entry*100;pnl+=notional*(pp/100)-fee;if(pp>0)w++;else l++;break;}}
    }
  }
  return {wr:w+l?+(w/(w+l)*100).toFixed(1):0,n:w+l,pnl:+pnl.toFixed(2)};
}

(async()=>{
  const pg=new Client({connectionString:PG_DSN});await pg.connect();
  const syms=['BTCUSDT','ETHUSDT','SOLUSDT'],ivs=['15m','1h','4h'];
  const strats=[['ema_cross',9,21],['bb_break',20,0],['trend_pull',21,0]];
  const out=[];
  out.push('STRAT P | BTC15 ETH15 SOL15 BTC1h ETH1h SOL1h BTC4h ETH4h SOL4h');
  for(const [s,p1,p2] of strats){
    const cells=[];
    for(const sym of syms)for(const iv of ivs){
      const r=await pg.query('SELECT close,high,low,open FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3',[sym,iv,6000]);
      const cd=r.rows.reverse();
      const res=backtest(cd,s,p1,p2);
      cells.push(`${res.wr}/${res.n}`);
    }
    out.push(`${s} ${p1} | ${cells.join(' ')}`);
  }
  fs.writeFileSync('/tmp/sweep2.txt',out.join('\n'));
  await pg.end();
})().catch(e=>{fs.writeFileSync('/tmp/sweep2_err.txt',e.message);});
