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

function stochRSI(closes, period = 14, k = 3, d = 3) {
  if (closes.length < period + k) return null;
  const rsi = [];
  for (let i = 1; i <= period; i++) {
    let g = 0, l = 0;
    for (let j = i; j < i + period; j++) {
      const ch = closes[j] - closes[j-1];
      if (ch >= 0) g += ch; else l -= ch;
    }
    const rs = l === 0 ? 100 : g / l;
    rsi.push(100 - 100 / (1 + rs));
  }
  const stoch = [];
  for (let i = period; i < rsi.length; i++) {
    const win = rsi.slice(i - k + 1, i + 1);
    const hi = Math.max(...win), lo = Math.min(...win);
    stoch.push(hi === lo ? 50 : ((rsi[i] - lo) / (hi - lo)) * 100);
  }
  const last = stoch[stoch.length - 1] || 50;
  const sig = stoch.length >= d ? stoch.slice(-d).reduce((a,b)=>a+b,0)/d : last;
  return { k: +last.toFixed(1), d: +sig.toFixed(1) };
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

  // Fast scalp trigger: score >= 1 long, <= -1 short
  let side = null;
  if (score >= 1) side = 'LONG';
  else if (score <= -1) side = 'SHORT';

  return { side, score, reasons: reasons.join(' | '), depth, vwap: dev, stoch: sr ? sr.k : null };
}

module.exports = { analyze, stochRSI, vwap, volSpike, getDepth };
