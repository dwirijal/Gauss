const { Client } = require('pg');
const fs = require('fs');
const bt = fs.readFileSync(__dirname + '/backtest_tick.js', 'utf8');
const m = bt.match(/PG_DSN = process\.env\.PG_DSN \|\| '([^']+)'/);
const PG_DSN = m ? m[1] : process.env.PG_DSN;
const SL = 1.0, TD = 0.15, FEE = 0.0004, CAPITAL = 20, RISK = Math.max(CAPITAL * 0.02, 1);
const notional = RISK / (SL / 100);
const fee = notional * FEE * 2;
function emaArr(closes, p){const k=2/(p+1),e=[closes[0]];for(let i=1;i<closes.length;i++)e.push(closes[i]*k+e[i-1]*(1-k));return e;}
function rsiArr(closes,p){const e=[50];let g=0,l=0;for(let i=1;i<closes.length;i++){const ch=closes[i]-closes[i-1];g=g*0.9+Math.max(ch,0)*0.1;l=l*0.9+Math.max(-ch,0)*0.1;e.push(l===0?50:100-100/(1+g/l));}return e;}

function backtest(cd, strat, p1) {
  let w=0,l=0,pnl=0;
  const c=cd.map(x=>x.close),h=cd.map(x=>x.high),lw=cd.map(x=>x.low),o=cd.map(x=>x.open);
  const ema=emaArr(c,p1),rsi=rsiArr(c,p1);
  for(let i=p1+1;i<cd.length;i++){
    let side=null,entry=null;
    if(strat==='ema_meanrev'){
      // long when close > ema but rsi oversold pullback, short vice versa
      if(c[i]<ema[i]&&rsi[i]<35&&c[i]>c[i-1]){side='L';entry=c[i];}
      else if(c[i]>ema[i]&&rsi[i]>65&&c[i]<c[i-1]){side='S';entry=c[i];}
    } else if(strat==='rsi_extreme'){
      if(rsi[i]<25&&rsi[i-1]>=25){side='L';entry=c[i];}
      else if(rsi[i]>75&&rsi[i-1]<=75){side='S';entry=c[i];}
    } else if(strat==='ema_trend'){
      if(c[i]>ema[i]&&ema[i]>ema[i-1]){side='L';entry=c[i];}
      else if(c[i]<ema[i]&&ema[i]<ema[i-1]){side='S';entry=c[i];}
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
  const strats=[['ema_meanrev',20],['rsi_extreme',14],['ema_trend',50]];
  const out=[];out.push('STRAT P | BTC15 ETH15 SOL15 BTC1h ETH1h SOL1h BTC4h ETH4h SOL4h');
  for(const [s,p1] of strats){
    const cells=[];
    for(const sym of syms)for(const iv of ivs){
      const r=await pg.query('SELECT close,high,low,open FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3',[sym,iv,6000]);
      const cd=r.rows.reverse();const res=backtest(cd,s,p1);
      cells.push(`${res.wr}/${res.n}`);
    }
    out.push(`${s} ${p1} | ${cells.join(' ')}`);
  }
  fs.writeFileSync('/tmp/sweep3.txt',out.join('\n'));
  await pg.end();
})().catch(e=>{fs.writeFileSync('/tmp/sweep3_err.txt',e.message);});
