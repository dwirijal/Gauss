#!/usr/bin/env node
const https = require('https'), crypto = require('crypto'), fs = require('fs');
const ENV = {};
for (const l of fs.readFileSync(process.env.HOME + '/.hermes/.env', 'utf8').split('\n')) {
  const t = l.trim(); if (t.startsWith('BINANCE_DEMO2_')) { const i = t.indexOf('='); ENV[t.slice(0,i)] = t.slice(i+1); }
}
const KEY = ENV.BINANCE_DEMO2_API_KEY, SEC = ENV.BINANCE_DEMO2_SECRET, BASE = 'https://testnet.binancefuture.com';
const SYMS = ['BTCUSDT','ETHUSDT','SOLUSDT'];
function getTrades(sym) {
  return new Promise((resolve) => {
    const ts = Date.now(), qs = `symbol=${sym}&timestamp=${ts}&recvWindow=5000`;
    const sig = crypto.createHmac('sha256', SEC).update(qs).digest('hex');
    const req = https.get(`${BASE}/fapi/v1/userTrades?${qs}&signature=${sig}`, { headers: {'X-MBX-APIKEY': KEY} }, r => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve([]);}});
    });
    req.on('error',()=>resolve([])); req.setTimeout(8000,()=>{req.destroy();resolve([]);});
  });
}
async function main() {
  const log = []; let totW=0, totL=0, totPnl=0;
  for (const sym of SYMS) {
    const trades = await getTrades(sym);
    let w=0,l=0,pnl=0;
    for (const t of trades) { const rp = parseFloat(t.realizedPnl); pnl += rp; if (rp>0) w++; else if (rp<0) l++; }
    log.push({ sym, trades: trades.length, wins: w, losses: l, pnl: +pnl.toFixed(2) });
    totW += w; totL += l; totPnl += pnl;
    fs.appendFileSync(__dirname + '/learning_log.json', JSON.stringify({ ts: Date.now(), sym, trades: trades.length, wins: w, losses: l, pnl: +pnl.toFixed(2) }) + '\n');
  }
  const wr = (totW+totL) ? (totW/(totW+totL)*100).toFixed(1) : 0;
  const report = { ts: new Date().toISOString(), totalTrades: totW+totL, wins: totW, losses: totL, wr: +wr, netPnl: +totPnl.toFixed(2), perSymbol: log };
  fs.writeFileSync(__dirname + '/reports/last_eval.json', JSON.stringify(report, null, 2));
  const md = `# KalAI Eval — ${report.ts}\n\n- **Total trades:** ${report.totalTrades}\n- **WR:** ${report.wr}%\n- **Net PnL:** ${report.netPnl>=0?'+':''}$${report.netPnl}\n\n| Pair | Trades | W | L | PnL |\n|------|--------|---|---|-----|\n` + log.map(x=>`| ${x.sym} | ${x.trades} | ${x.wins} | ${x.losses} | ${x.pnl>=0?'+':''}$${x.pnl} |`).join('\n') + '\n';
  fs.writeFileSync(__dirname + '/reports/eval_' + Date.now() + '.md', md);
  console.log(JSON.stringify(report));
}
main();
