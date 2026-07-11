const { Client } = require('pg'); const fs = require('fs');
const S = require('./strategy.js');
const bt = fs.readFileSync(__dirname + '/backtest_tick.js', 'utf8');
const m = bt.match(/PG_DSN = process\.env\.PG_DSN \|\| '([^']+)'/);
const pg = new Client({ connectionString: m ? m[1] : process.env.PG_DSN });
const SL = parseFloat(process.env.SL||'1.0'), TD = parseFloat(process.env.TD||'0.15'), FEE = 0.0004, CAPITAL = 20, RISK = Math.max(CAPITAL*0.02,1);
const notional = RISK/(SL/100), fee = notional*FEE*2;
// score threshold from env
const TH = parseInt(process.env.TH||'2');

function backtest(cd) {
  let w=0,l=0,pnl=0;
  const c=cd.map(x=>x.close),h=cd.map(x=>x.high),lw=cd.map(x=>x.low),v=cd.map(x=>x.vol);
  for (let i=50;i<cd.length;i++) {
    const slice={closes:c.slice(0,i+1),highs:h.slice(0,i+1),lows:lw.slice(0,i+1),volumes:v.slice(0,i+1)};
    const r=S.stochRSI(slice.closes); const vw=S.vwap(slice.closes,slice.volumes); const vs=S.volSpike(slice.volumes);
    const price=c[i]; let score=0; const hh=Math.max(...h.slice(i-20,i)), ll=Math.min(...lw.slice(i-20,i));
    if(r){if(r.k<20&&r.k>r.d)score++;else if(r.k>80&&r.k<r.d)score--;}
    const dev=(price-vw)/vw*100; if(dev<-0.3)score++;else if(dev>0.3)score--;
    if(price>=hh*0.999)score++;else if(price<=ll*1.001)score--;
    let side=null; if(score>=TH)side='L';else if(score<=-TH)side='S'; else continue;
    const slc=side==='L'?price*(1-SL/100):price*(1+SL/100); const tpl=side==='L'?price*(1+SL/100):price*(1-SL/100);
    let tr=false;
    for(let j=i+1;j<Math.min(i+600,cd.length);j++){
      const hj=h[j],lj=lw[j],cj=c[j];
      if(!tr){if(side==='L'?hj>=tpl:lj<=tpl){tr=true;continue;}}
      if(tr){const tpN=side==='L'?cj*(1-TD/100):cj*(1+TD/100);if(side==='L'?lj<=tpN:hj>=tpN){const pp=side==='L'?(tpN-price)/price*100:(price-tpN)/price*100;pnl+=notional*(pp/100)-fee;if(pp>0)w++;else l++;break;}}
      else{if(side==='L'?lj<=slc:hj>=slc){const pp=side==='L'?(slc-price)/price*100:(price-slc)/price*100;pnl+=notional*(pp/100)-fee;if(pp>0)w++;else l++;break;}}
    }
  }
  return {wr:w+l?+(w/(w+l)*100).toFixed(1):0,n:w+l,pnl:+pnl.toFixed(2)};
}
(async()=>{
  await pg.connect();
  const out=[];
  for(const sym of ['BTCUSDT','ETHUSDT','SOLUSDT']){
    const cells=[];
    for(const iv of ['15m','1h','4h']){
      const r=await pg.query('SELECT close,high,low,volume FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts',[sym,iv]);
      const res=backtest(r.rows); cells.push(`${res.wr}/${res.n}`);
    }
    out.push(`${sym} (TH=${TH} SL=${SL} TD=${TD}): ${cells.join(' ')}`);
  }
  fs.writeFileSync('/tmp/btv2.txt', out.join('\n'));
  await pg.end();
})().catch(e=>fs.writeFileSync('/tmp/btv2_err.txt',e.message));
