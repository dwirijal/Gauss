// KalAI strategy v2.1 [trap-fixed+regime-gate]
// STRATEGY_V2.1 — multi-signal with reasoning. Lean, no deps.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const ENV = {};
for (const l of fs.readFileSync(process.env.HOME + '/.hermes/.env', 'utf8').split('\n')) {
  const t = l.trim(); if (t.startsWith('BINANCE_DEMO2_')) { const i = t.indexOf('='); ENV[t.slice(0,i)] = t.slice(i+1); }
}
const KEY = ENV.BINANCE_DEMO2_API_KEY, SEC = ENV.BINANCE_DEMO2_SECRET, BASE = 'https://testnet.binancefuture.com';

const { StochasticRSI } = require('technicalindicators');
function stochRSI(closes, period = 14, k = 3, d = 3) {
  if (closes.length < period * 2 + k) return null;
  const r = StochasticRSI.calculate({ values: closes, rsiPeriod: period, stochasticPeriod: period, kPeriod: k, dPeriod: d });
  const last = r[r.length - 1];
  if (!last) return null;
  return { k: +last.k.toFixed(1), d: +last.d.toFixed(1) };
}

function vwap(closes, volumes) {
  let pv = 0, v = 0;
  for (let i = 0; i < closes.length; i++) { pv += closes[i] * volumes[i]; v += volumes[i]; }
  return v ? pv / v : closes[closes.length - 1];
}

function volSpike(volumes, period = 20) {
  const recent = volumes.slice(-period);
  const avg = recent.reduce((a,b)=>a+b,0) / recent.length;
  const last = volumes[volumes.length - 1];
  return { ratio: avg ? last / avg : 1, avg };
}

// depth-based trap detection (live only)
function getDepth(symbol) {
  return new Promise((resolve) => {
    const ts = Date.now(), qs = `symbol=${symbol}&limit=50`;
    const sig = crypto.createHmac('sha256', SEC).update(qs).digest('hex');
    const req = https.get(`${BASE}/fapi/v1/depth?${qs}&signature=${sig}`, { headers: {'X-MBX-APIKEY': KEY} }, r => {
      let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{const j=JSON.parse(d);
        const bidV = j.bids.slice(0,10).reduce((a,b)=>a+parseFloat(b[1]),0);
        const askV = j.asks.slice(0,10).reduce((a,b)=>a+parseFloat(b[1]),0);
        resolve({ imbalance: bidV/(bidV+askV), bidVol: bidV, askVol: askV, topBid: +j.bids[0][0], topAsk: +j.asks[0][0] });
      }catch(e){resolve(null);}});
    });
    req.on('error',()=>resolve(null)); req.setTimeout(6000,()=>{req.destroy();resolve(null);});
  });
}

// Main signal with reasoning. candles = {closes, highs, lows, volumes}
async function analyze(symbol, candles, regime) {
  console.error('[STRAT V2.1 SCALP-ACTIVE] '+symbol);
  const c = candles.closes, h = candles.highs, l = candles.lows, v = candles.volumes;
  const reasons = [];
  let score = 0;
  
  // Fetch orderbook depth data
  const depth = await getDepth(symbol);
  
  // 1. StochRSI
  const sr = stochRSI(c);
  if (sr) {
    if (sr.k < 25 && sr.k > sr.d) { score += 1; reasons.push(`StochRSI oversold-turn(${sr.k}/${sr.d})→LONG`); }
    else if (sr.k > 75 && sr.k < sr.d) { score -= 1; reasons.push(`StochRSI overbought-turn(${sr.k}/${sr.d})→SHORT`); }
  }
  
  // 2. VWAP deviation
  const vw = vwap(c, v);
  const price = c[c.length - 1];
  const dev = (price - vw) / vw * 100;
  if (dev < -0.15) { score += 1; reasons.push(`below VWAP ${dev.toFixed(2)}%→LONG`); }
  else if (dev > 0.15) { score -= 1; reasons.push(`above VWAP ${dev.toFixed(2)}%→SHORT`); }
  
  // 3. Volume spike & breakout (fast 10-bar tracking)
  const vs = volSpike(v);
  if (vs.ratio > 1.5) {
    reasons.push(`VOL SPIKE ${vs.ratio.toFixed(1)}x`);
    const hh = Math.max(...h.slice(-10)), ll = Math.min(...l.slice(-10));
    if (price >= hh * 0.9995) { score += 1; reasons.push('breakout-high'); }
    else if (price <= ll * 1.0005) { score -= 1; reasons.push('breakout-low'); }
  }
  
  // 4. Depth trap imbalance (orderbook volume bias)
  if (depth) {
    if (depth.imbalance > 0.56) { score += 1; reasons.push(`bid-heavy(${(depth.imbalance*100).toFixed(0)}%)→LONG`); }
    else if (depth.imbalance < 0.44) { score -= 1; reasons.push(`ask-heavy(${(depth.imbalance*100).toFixed(0)}%)→SHORT`); }
  }

  // ponytail: confluence gate |score|>=2 (was >=1 fired on single noise trigger, WR 16.7%). Backtest_v3 needs HTF+fib+stoch+buyRatio; require 2+ aligned triggers here. Raise to 3 if still overtrading.
  let side = null;
  if (score >= 2) side = 'LONG';
  else if (score <= -2) side = 'SHORT';

  return { side, score, reasons: reasons.join(' | '), depth, vwap: dev, stoch: sr ? sr.k : null };
}

module.exports = { analyze, stochRSI, vwap, volSpike, getDepth };
