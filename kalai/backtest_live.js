// Live-strategy replay backtester — mirrors kalai/index.js mechanics on historical 1m klines.
// Backtest Gate instrument (CTO loop step 3): measure true live WR before/after optimization.
// ponytail: depth/orderbook imbalance omitted (no historical L2 on testnet); 3 pure triggers kept consistent via strategy.js.
'use strict';
const axios = require('axios');
const { EMA } = require('technicalindicators');
const S = require('./strategy.js');

const SYMS = (process.env.KALAI_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const LIMIT = parseInt(process.env.BT_LIMIT || '1000');
const TP_PCT = parseFloat(process.env.BT_TP || '0.4');
const SL_PCT = parseFloat(process.env.BT_SL || '0.4');
const TRAIL_DIST = parseFloat(process.env.BT_TRAIL || '0.15');
const GATE = parseInt(process.env.BT_GATE || '2');
const USE_REGIME = process.env.BT_REGIME === '1';
const BASE = 'https://fapi.binance.com';

async function klines(sym, limit) {
  const r = await axios.get(`${BASE}/fapi/v1/klines`, { params: { symbol: sym, interval: '1m', limit } });
  return r.data.map(k => ({ open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
}

function classifyRegime(closes, highs, lows) {
  const n = closes.length;
  if (n < 70) return 'CHOPPY';
  const e50 = EMA.calculate({ values: closes, period: 50 });
  const slope = (e50[n-1] - e50[n-21]) / e50[n-21] * 100;
  let atr = 0; for (let i = n-20; i < n; i++) atr += Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  atr /= 20; const vol = atr / closes[n-1] * 100;
  if (vol > 0.8) return 'CHOPPY';
  if (slope > 0.3) return 'BULL';
  if (slope < -0.3) return 'BEAR';
  return 'CHOPPY';
}

// score via the SAME pure triggers as strategy.js (minus live depth)
function score(c) {
  let s = 0, parts = 0;
  const sr = S.stochRSI(c.closes);
  if (sr) { if (sr.k < 25 && sr.k > sr.d) { s += 1; parts++; } else if (sr.k > 75 && sr.k < sr.d) { s -= 1; parts++; } }
  const vw = S.vwap(c.closes, c.volumes);
  const dev = (c.close - vw) / vw * 100;
  if (dev < -0.15) { s += 1; parts++; } else if (dev > 0.15) { s -= 1; parts++; }
  const vs = S.volSpike(c.volumes);
  if (vs.ratio > 1.5) { const hh = Math.max(...c.highs.slice(-10)), ll = Math.min(...c.lows.slice(-10)); if (c.close >= hh*0.9995) { s += 1; parts++; } else if (c.close <= ll*1.0005) { s -= 1; parts++; } }
  return s;
}

// simulate bot-managed exit (RR1:1 + trailing + BE lock) on forward 1m series
function simulate(side, entry, fwd) {
  const tp = side==='LONG' ? entry*(1+TP_PCT/100) : entry*(1-TP_PCT/100);
  const sl = side==='LONG' ? entry*(1-SL_PCT/100) : entry*(1+SL_PCT/100);
  let best = entry, slP = sl, trailed = false;
  for (const k of fwd) {
    const px = k.close;
    best = side==='LONG' ? Math.max(best, px) : Math.min(best, px);
    const move = side==='LONG' ? (px-entry)/entry*100 : (entry-px)/entry*100;
    if (move >= TP_PCT*0.5) { const be = side==='LONG' ? entry*1.0008 : entry*0.9992; if (side==='LONG' ? slP<be : slP>be) slP = be; }
    if (!trailed && move >= TRAIL_DIST) trailed = true;
    if (trailed) { const t = side==='LONG' ? best*(1-TRAIL_DIST/100) : best*(1+TRAIL_DIST/100); if (side==='LONG' ? t>slP : t<slP) slP = t; }
    if (side==='LONG' ? px>=tp : px<=tp) return 'TP';
    if (side==='LONG' ? px<=slP : px>=slP) return 'SL';
  }
  return 'OPEN';
}

async function run() {
  let wins=0, losses=0, total=0;
  for (const sym of SYMS) {
    const ks = await klines(sym, LIMIT);
    let symW=0, symL=0;
    const START = 60;
    for (let i = START; i < ks.length - 30; i++) {
      const slice = ks.slice(0, i+1);
      const c = { opens:[], highs:slice.map(k=>k.high), lows:slice.map(k=>k.low), closes:slice.map(k=>k.close), volumes:slice.map(k=>k.volume), close:ks[i].close, high:ks[i].high, low:ks[i].low };
      const sc = score(c);
      let side = sc>=GATE ? 'LONG' : sc<=-GATE ? 'SHORT' : null;
      if (!side) continue;
      // ponytail: live analyze() ignores regime (no HTF filter yet) — gate mirrors live, so no regime skip here. USE_REGIME retained only for future HTF-port comparison (Task #4).
      if (USE_REGIME) { const regime = classifyRegime(c.closes, c.highs, c.lows); if (side==='LONG' && regime==='BEAR') continue; if (side==='SHORT' && regime==='BULL') continue; }
      const res = simulate(side, ks[i].close, ks.slice(i+1, i+31));
      if (res === 'TP') { wins++; symW++; }
      else if (res === 'SL') { losses++; symL++; }
      total++;
    }
    console.log(`  ${sym}: ${symW}W / ${symL}L`);
  }
  const wr = total ? (wins/(wins+losses)*100).toFixed(1) : 0;
  console.log(`\n[BT-LIVE] regime=${USE_REGIME?'ON':'OFF'} gate=${GATE} | trades=${total} WR=${wr}% (${wins}W/${losses}L)`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
