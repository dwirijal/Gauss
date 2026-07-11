const { Client } = require('pg');
const fs = require('fs');
const bt = fs.readFileSync(__dirname + '/backtest_tick.js', 'utf8');
const m = bt.match(/PG_DSN = process\.env\.PG_DSN \|\| '([^']+)'/);
const PG_DSN = m ? m[1] : process.env.PG_DSN;
const SL = 1.0, TD = 0.15, FEE = 0.0004, CAPITAL = 20, RISK = Math.max(CAPITAL * 0.02, 1);
const notional = RISK / (SL / 100);
const fee = notional * FEE * 2;

function test(cd, dgs, useFilter) {
  let w=0,l=0,pnl=0;
  const c=cd.map(x=>x.close),h=cd.map(x=>x.high),lw=cd.map(x=>x.low);
  // map each candle ts to dgs10 value + slope
  let di=0;
  for(let i=21;i<cd.length;i++){
    const hh=Math.max(...cd.slice(i-20,i).map(x=>x.high));
    const ll=Math.min(...cd.slice(i-20,i).map(x=>x.low));
    const ci=c[i];
    let side=null,entry=null;
    if(ci>=hh*0.999)side='L';else if(ci<=ll*1.001)side='S';else continue;
    if(useFilter){
      // find dgs10 at this candle
      while(di<dgs.length-1 && dgs[di+1].ts<=cd[i].ts)di++;
      const cur=dgs[di].v, prev=dgs[Math.max(0,di-30)].v; // ~30 candles back proxy
      const rising=cur>prev;
      if(side==='L'&&rising)continue; // risk-off: no longs
      if(side==='S'&&!rising)continue; // risk-on: no shorts
    }
    entry=ci;
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
  const dgs=await pg.query("SELECT ts,v FROM fred_events WHERE series_id='DGS10' ORDER BY ts");
  const dgsA=dgs.rows.map(r=>({ts:r.ts, v:parseFloat(r.v)}));
  const syms=['BTCUSDT','ETHUSDT','SOLUSDT'],ivs=['15m','1h','4h'];
  const out=[];out.push('FILTER | BTC15 ETH15 SOL15 BTC1h ETH1h SOL1h BTC4h ETH4h SOL4h');
  for(const f of [false,true]){
    const cells=[];
    for(const sym of syms)for(const iv of ivs){
      const r=await pg.query('SELECT close,high,low,ts FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts',[sym,iv]);
      const cd=r.rows;const res=test(cd,dgsA,f);
      cells.push(`${res.wr}/${res.n}`);
    }
    out.push(`${f?1:0} | ${cells.join(' ')}`);
  }
  fs.writeFileSync('/tmp/sweep_macro.txt',out.join('\n'));
  await pg.end();
})().catch(e=>{fs.writeFileSync('/tmp/sweep_macro_err.txt',e.message);});
