'use strict';
// Faithful replay backtester for the KalAI live counter-trend mean-reversion engine.
// Mirrors index.js handleSignal() entry gate + startMonitor() exit mechanics, bar-by-bar on historical 1m klines.
// ponytail: depth/orderbook imbalance trigger (live #4) omitted — no historical L2; 3 pure triggers kept from strategy.js.

const axios = require('axios');
const { stochRSI, vwap, volSpike } = require('./strategy.js');

const SYMS = (process.env.KALAI_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const TP_PCT = 0.4;          // task: RR1:1 TP=SL=0.4%
const SL_PCT = 0.4;
const TRAIL = 0.15;          // task: trailing stop 0.15%
const GATE = 2;              // |score|>=2
const RISK = 1;              // $ risk per trade
const LEV = 5;
const FEE_RT = 0.0004;       // 0.04% round-trip on notional
const NEED = 4500;           // >=4320 (3 days) bars
const WARMUP = 60;           // bars before stochRSI/k are valid

// ---- score: 3 pure triggers (no depth) ----
function score(close, high, low, vol) {
  let s = 0;
  const sr = stochRSI(close);
  if (sr) {
    if (sr.k < 25 && sr.k > sr.d) s += 1;
    else if (sr.k > 75 && sr.k < sr.d) s -= 1;
  }
  const vw = vwap(close, vol);
  const price = close[close.length - 1];
  const dev = (price - vw) / vw * 100;
  if (dev < -0.15) s += 1;
  else if (dev > 0.15) s -= 1;
  const vs = volSpike(vol);
  if (vs.ratio > 1.5) {
    const hh = Math.max(...high.slice(-10)), ll = Math.min(...low.slice(-10));
    if (price >= hh * 0.9995) s += 1;
    else if (price <= ll * 1.0005) s -= 1;
  }
  return s;
}

// ---- exit: mirrors index.js startMonitor() every tick (here every bar close) ----
// returns {res:'TP'|'SL'|'OPEN', idx: offset within fwd}
function exit(side, entry, fwd) {
  const isL = side === 'LONG';
  const tp = entry * (isL ? 1 + TP_PCT / 100 : 1 - TP_PCT / 100);
  let sl = entry * (isL ? 1 - SL_PCT / 100 : 1 + SL_PCT / 100);
  let best = entry, trailed = false;
  for (let j = 0; j < fwd.length; j++) {
    const px = fwd[j].close;
    best = isL ? Math.max(best, px) : Math.min(best, px);
    const move = isL ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
    if (move >= TP_PCT * 0.5) {                       // BE lock at 50% TP
      const be = isL ? entry * 1.0008 : entry * 0.9992;
      if (isL ? sl < be : sl > be) sl = be;
    }
    if (!trailed && move >= TRAIL) trailed = true;       // trail engages at 0.15%
    if (trailed) {
      const t = isL ? best * (1 - TRAIL / 100) : best * (1 + TRAIL / 100);
      if (isL ? t > sl : t < sl) sl = t;
    }
    if (isL ? px >= tp : px <= tp) return { res: 'TP', idx: j };
    if (isL ? px <= sl : px >= sl) return { res: 'SL', idx: j };
  }
  return { res: 'OPEN', idx: fwd.length };
}

function wilson(wins, n) {
  if (!n) return [0, 0];
  const p = wins / n, z = 1.96;
  const den = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / den;
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [+(center - margin).toFixed(4), +(center + margin).toFixed(4)];
}

async function getJSON(url, params, tries = 5) {
  for (let i = 0; i < tries; i++) {
    try { return (await axios.get(url, { params })).data; }
    catch (e) {
      if (i === tries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1))); // ponytail: linear backoff on 429/418
    }
  }
}

async function fetchKlines(symbol) {
  const BASE = 'https://fapi.binance.com';
  let endTime = Date.now() - 60 * 1000; // skip in-progress bar
  const chunks = [];
  while (true) {
    const b = await getJSON(`${BASE}/fapi/v1/klines`, {
      symbol, interval: '1m', limit: 1500, endTime,
    });
    if (!b.length) break;
    chunks.push(b);
    if (b.length < 1500) break;
    endTime = b[0][0] - 1;
    await new Promise(r => setTimeout(r, 250));
  }
  const bars = [];
  const seen = new Set();
  for (let i = chunks.length - 1; i >= 0; i--) {        // oldest first
    for (const k of chunks[i]) {
      const t = k[0];
      if (seen.has(t)) continue;
      seen.add(t);
      bars.push({ openTime: t, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] });
    }
  }
  bars.sort((a, b) => a.openTime - b.openTime);
  return bars;
}

async function run() {
  const out = { range: null, perSymbol: [], total: {}, caveat: null };
  let allW = 0, allL = 0, allO = 0, allPnl = 0;
  const notional = RISK / (SL_PCT / 100);   // 250
  const fee = notional * FEE_RT;             // 0.10
  const perTP = notional * TP_PCT / 100 - fee;
  const perSL = -notional * SL_PCT / 100 - fee;

  for (const sym of SYMS) {
    console.error(`[fetch] ${sym}...`);
    const bars = await fetchKlines(sym);
    if (bars.length < NEED) console.error(`  warn: only ${bars.length} bars (<${NEED})`);
    let w = 0, l = 0, o = 0, pnl = 0, busyUntil = 0;
    for (let i = WARMUP; i < bars.length; i++) {
      if (i < busyUntil) continue;
      const close = bars.slice(0, i + 1).map(b => b.close);
      const high = bars.slice(0, i + 1).map(b => b.high);
      const low = bars.slice(0, i + 1).map(b => b.low);
      const vol = bars.slice(0, i + 1).map(b => b.volume);
      const sc = score(close, high, low, vol);
      let side = null;
      if (sc >= GATE) side = 'LONG';
      else if (sc <= -GATE) side = 'SHORT';
      else continue;
      const entry = bars[i].close;
      const { res, idx } = exit(side, entry, bars.slice(i + 1));
      if (res === 'TP') { w++; pnl += perTP; busyUntil = i + 1 + idx + 1; }
      else if (res === 'SL') { l++; pnl += perSL; busyUntil = i + 1 + idx + 1; }
      else { o++; busyUntil = i + 1; }   // never closed in data: hold (live has no time stop)
    }
    const tot = w + l;
    const wr = tot ? +(w / tot * 100).toFixed(1) : 0;
    out.perSymbol.push({ sym, trades: tot, win: w, loss: l, open: o, wr, netPnl: +pnl.toFixed(2) });
    allW += w; allL += l; allO += o; allPnl += pnl;
    const r0 = new Date(bars[0].openTime).toISOString();
    const r1 = new Date(bars[bars.length - 1].openTime).toISOString();
    out.range = out.range || { start: r0, end: r1, bars: bars.length };
    out.range.bars = Math.min(out.range.bars, bars.length);
    console.error(`  ${sym}: ${w}W/${l}L/${o}OPEN  WR=${wr}%  netPnL=$${pnl.toFixed(2)}`);
  }
  const tot = allW + allL;
  const wr = tot ? +(allW / tot * 100).toFixed(1) : 0;
  const [lo, hi] = wilson(allW, tot);
  out.total = { trades: tot, win: allW, loss: allL, open: allO, wr, ci95: [lo, hi], netPnl: +allPnl.toFixed(2) };
  out.capital = 20; out.riskPerTrade = RISK; out.leverage = LEV;
  out.caveat = 'Depth/orderbook-imbalance trigger (live #4) omitted — no historical L2. Replay uses 3 pure triggers (StochRSI turn, VWAP±0.15%, vol-spike breakout) with score>=2 gate. Exit = RR1:1 TP=SL=0.4%, BE lock at 50% TP, 0.15% trailing, bar-close fills only. Margin per trade (notional/lev = $50) exceeds stated $20 capital — $20 is under-collateralized at $1 risk.';
  require('fs').writeFileSync('/home/dwizzy/dwizzyOS/gauss/kalai/wr_study_harvest.json', JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

run().catch(e => { console.error(e); process.exit(1); });
