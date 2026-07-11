// SIGNAL FAMILY B: RANGE-GATED COUNTER-TREND prototype.
// Reuses score()/simulate()/classifyRegime() from backtest_live.js verbatim.
// Variants: (a) baseline no regime filter, (b) CHOPPY-only, (c) CHOPPY + 15m EMA-slope.
'use strict';
const fs = require('fs');
const path = require('path');
const { EMA } = require('technicalindicators');
const S = require('../strategy.js');
const { StochasticRSI } = require('technicalindicators');

const TP_PCT = 0.4, SL_PCT = 0.4, TRAIL_DIST = 0.15, GATE = 2;
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const DIR = __dirname;
const M15_MS = 900000;

// ---- verbatim reuse from backtest_live.js ----
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
// srFull: precomputed full-series StochasticRSI (null until valid). srFull[i] === S.stochRSI(closes.slice(0,i+1)).
function score(c, sr) {
  let s = 0, parts = 0;
  if (sr) { if (sr.k < 25 && sr.k > sr.d) { s += 1; parts++; } else if (sr.k > 75 && sr.k < sr.d) { s -= 1; parts++; } }
  const vw = S.vwap(c.closes, c.volumes);
  const dev = (c.close - vw) / vw * 100;
  if (dev < -0.15) { s += 1; parts++; } else if (dev > 0.15) { s -= 1; parts++; }
  const vs = S.volSpike(c.volumes);
  if (vs.ratio > 1.5) { const hh = Math.max(...c.highs.slice(-10)), ll = Math.min(...c.lows.slice(-10)); if (c.close >= hh*0.9995) { s += 1; parts++; } else if (c.close <= ll*1.0005) { s -= 1; parts++; } }
  return s;
}
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

// precompute 15m EMA(50) slope at each m15 bar (null until valid)
function m15SlopeSeries(m15) {
  const closes = m15.map(k => k.close);
  const out = new Array(closes.length).fill(null);
  for (let j = 0; j < closes.length; j++) {
    const win = closes.slice(0, j+1);
    if (win.length < 70) continue; // match regime guard (needs n-21>=49 -> n>=70)
    const e = EMA.calculate({ values: win, period: 50 });
    out[j] = (e[e.length-1] - e[e.length-21]) / e[e.length-21] * 100;
  }
  return out;
}
function m15IdxAt(m15, t) { return Math.floor((t - m15[0].t) / M15_MS); }

// run a variant. mode: 'a' | 'b' | 'c'
function runVariant(ksBy, m15By, mode) {
  const agg = { trades: 0, wins: 0, losses: 0, netPnl: 0, perSymbol: {} };
  for (const sym of SYMS) {
    const ks = ksBy[sym], m15 = m15By[sym], slope15 = m15SlopeSeries(m15);
    // precompute full StochasticRSI once (O(n)); srFull[i] === S.stochRSI(slice(0,i+1)) (causal, identical)
    const closesFull = ks.map(k => k.c);
    const srCalc = StochasticRSI.calculate({ values: closesFull, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
    const W = closesFull.length - srCalc.length; // warmup offset; srCalc[j] -> input idx j+W
    const srFull = closesFull.map((_, i) => (i - W >= 0 && srCalc[i-W]) ? { k: +(+srCalc[i-W].k).toFixed(1), d: +(+srCalc[i-W].d).toFixed(1) } : null);
    let symW = 0, symL = 0;
    for (let i = 60; i < ks.length - 30; i++) {
      const slice = ks.slice(0, i+1);
      const c = { highs: slice.map(k=>k.high), lows: slice.map(k=>k.low), closes: slice.map(k=>k.close), volumes: slice.map(k=>k.volume), close: ks[i].close, high: ks[i].high, low: ks[i].low };
      const sc = score(c, srFull ? srFull[i] : null);
      const side = sc >= GATE ? 'LONG' : sc <= -GATE ? 'SHORT' : null;
      if (!side) continue;
      if (mode === 'b' || mode === 'c') {
        const reg = classifyRegime(c.closes, c.highs, c.lows);
        if (reg !== 'CHOPPY') continue;
      }
      if (mode === 'c') {
        const j = m15IdxAt(m15, ks[i].t);
        if (j < 0 || j >= slope15.length || slope15[j] === null) continue;
        const sl = slope15[j];
        if (side === 'LONG' && !(sl >= -0.3 && sl <= 0.1)) continue;
        if (side === 'SHORT' && !(sl >= -0.1 && sl <= 0.3)) continue;
      }
      const res = simulate(side, ks[i].close, ks.slice(i+1, i+31));
      if (res === 'TP') { symW++; agg.wins++; agg.netPnl += TP_PCT; }
      else if (res === 'SL') { symL++; agg.losses++; agg.netPnl -= SL_PCT; }
      else continue; // OPEN: uncounted (faithful to live — only closed trades)
      agg.trades++;
    }
    agg.perSymbol[sym] = { trades: symW + symL, wins: symW, losses: symL, netPnl: +(symW*TP_PCT - symL*SL_PCT).toFixed(2), wr: symW+symL ? +(symW/(symW+symL)*100).toFixed(1) : 0 };
  }
  const n = agg.trades;
  const p = n ? agg.wins / n : 0;
  const ci = n ? 1.96 * Math.sqrt(p*(1-p)/n) : 0; // normal-approx 95% CI half-width on WR
  agg.wr = +(p*100).toFixed(1);
  agg.ci95 = [+((p-ci)*100).toFixed(1), +((p+ci)*100).toFixed(1)];
  agg.netPnl = +agg.netPnl.toFixed(2);
  return agg;
}

const ksBy = {}, m15By = {};
// normalize research raw (lowercase c/h/l/o/v) -> klines shape (.close/.high/.low/.open) that simulate() reads
for (const sym of SYMS) {
  ksBy[sym] = require(path.join(DIR, `raw_${sym}.json`)).map(k => ({ t: k.t, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v }));
  m15By[sym] = require(path.join(DIR, `m15_${sym}.json`)).map(k => ({ t: k.t, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v }));
}

const result = {
  design: 'Counter-trend fires LONG(>=+2)/SHORT(<=-2) on oversold/overbought+VWAP+vol. Fix: block entries unless 1m classifyRegime()===CHOPPY; variant(c) adds 15m EMA50 slope confluence (LONG -0.3..+0.1, SHORT -0.1..+0.3). gate=2, TP=SL=0.4%, trail=0.15%, 1m, forward 30 bars.',
  variants: {
    a: runVariant(ksBy, m15By, 'a'),
    b: runVariant(ksBy, m15By, 'b'),
    c: runVariant(ksBy, m15By, 'c'),
  },
  note: 'OPEN trades (no TP/SL within 30 bars) excluded from counts — faithful to live replay. CI95 = normal approx half-width on WR proportion.'
};
fs.writeFileSync(path.join(DIR, 'countertrend_range.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
