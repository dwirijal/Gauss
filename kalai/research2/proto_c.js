// Proto C: HTF-bias mean-reversion AT SCALE, multi-regime window.
// Reuses proto_htf.js entry logic but: confluence>=1, HTF slope +/-0.15%.
// Tests 3 exit models on the SAME entries. Local files only, no network.
'use strict';
const fs = require('fs');
const { EMA, StochasticRSI } = require('technicalindicators');

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CAPITAL = 20, LEV = 5, RISK = 1, FEE_RT = 0.0004;
const FEE = CAPITAL * LEV * FEE_RT;          // round-trip taker $ on notional
const PNL_PER_PCT = RISK / 0.4;              // prior's implied notional: 0.4% move = $1
const FIB_TOL = 0.0015, FIBS = [0.382, 0.5, 0.618];
const SLOPE_TH = 0.15;                        // widened from 0.3
const HORIZON = 120;                          // fwd 5m bars (10h) to resolve a trade

const load = f => JSON.parse(fs.readFileSync(f, 'utf8'));

function htfBias(h1) {
  const closes = h1.map(b => b.c);
  const ema = EMA.calculate({ values: closes, period: 50 });
  const out = new Array(h1.length).fill('FLAT');
  for (let i = 71; i < h1.length; i++) {
    const slope = (ema[i] - ema[i - 21]) / ema[i - 21] * 100;
    out[i] = slope > SLOPE_TH ? 'BULL' : slope < -SLOPE_TH ? 'BEAR' : 'FLAT';
  }
  return out;
}
function stochArr(m5) {
  const closes = m5.map(b => b.c);
  const r = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
  return r.map(x => x ? { k: +x.k.toFixed(1), d: +x.d.toFixed(1) } : null);
}
function fibLevels(h1, hIdx) {
  const lo = Math.max(0, hIdx - 19), win = h1.slice(lo, hIdx + 1);
  const hi = Math.max(...win.map(b => b.h)), low = Math.min(...win.map(b => b.l));
  return { lvls: FIBS.map(f => low + (hi - low) * f) };
}
// std exit: fixed TP/SL + trailing + optional BE lock
function simStd(side, entry, fwd, tpPct, slPct, trailPct, beLockAt) {
  const tp = side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = side === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let best = entry, slP = sl, trailed = false;
  for (const k of fwd) {
    const px = k.c;
    best = side === 'LONG' ? Math.max(best, px) : Math.min(best, px);
    const move = side === 'LONG' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
    if (beLockAt && move >= beLockAt) { const be = side === 'LONG' ? entry * 1.0008 : entry * 0.9992; if (side === 'LONG' ? slP < be : slP > be) slP = be; }
    if (!trailed && move >= trailPct) trailed = true;
    if (trailed) { const t = side === 'LONG' ? best * (1 - trailPct / 100) : best * (1 + trailPct / 100); if (side === 'LONG' ? t > slP : t < slP) slP = t; }
    if (side === 'LONG' ? px >= tp : px <= tp) return { out: 'TP', px: tp };
    if (side === 'LONG' ? px <= slP : px >= slP) return { out: 'SL', px: slP };
  }
  return { out: 'OPEN', px: fwd.length ? fwd[fwd.length - 1].c : entry };
}
// trail-only: no fixed TP, trailing callback after activation, hard SL
function simTrail(side, entry, fwd, actPct, callbackPct, hardSlPct) {
  const hard = side === 'LONG' ? entry * (1 - hardSlPct / 100) : entry * (1 + hardSlPct / 100);
  let best = entry, slP = hard, active = false;
  for (const k of fwd) {
    const px = k.c;
    best = side === 'LONG' ? Math.max(best, px) : Math.min(best, px);
    const move = side === 'LONG' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
    if (!active && move >= actPct) active = true;
    if (active) { const t = side === 'LONG' ? best * (1 - callbackPct / 100) : best * (1 + callbackPct / 100); if (side === 'LONG' ? t > slP : t < slP) slP = t; }
    const hit = side === 'LONG' ? px <= slP : px >= slP;
    if (hit) return { out: 'SL', px: Math.max(slP, hard) };
  }
  return { out: 'OPEN', px: fwd.length ? fwd[fwd.length - 1].c : entry };
}
function wilson(wins, n) {
  if (!n) return [0, 0];
  const p = wins / n, z = 1.96;
  const c = p + z * z / (2 * n), d = 1 + z * z / n;
  const s = Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [(c - s) * 100, (c + s) * 100];
}

// Build the SHARED entry set (one per qualifying 5m bar).
function entriesFor(sym) {
  const m5 = load(`research2/m5_${sym}.json`);
  const h1 = load(`research2/h1_${sym}.json`);
  const bias = htfBias(h1);
  const st = stochArr(m5);
  let hi = 0; const out = [];
  for (let i = 31; i < m5.length - 1; i++) {
    while (hi < h1.length - 1 && h1[hi + 1].t <= m5[i].t) hi++;
    const b = bias[hi];
    if (b === 'FLAT') continue;
    if (i < 1 || !st[i] || !st[i - 1]) continue;
    const cur = st[i], prev = st[i - 1];
    const o = m5[i], c = o.c, barPos = o.h > o.l ? (c - o.l) / (o.h - o.l) : 0.5;
    const fib = fibLevels(h1, hi);
    const nearFib = fib.lvls.some(lv => Math.abs(c - lv) / c < FIB_TOL);
    if (b === 'BULL') {
      const stochTurn = prev.k < 25 && prev.k <= prev.d && cur.k > cur.d;
      const buyProxy = barPos > 0.5;
      const aligned = [stochTurn, nearFib, buyProxy].filter(Boolean).length;
      if (aligned >= 1) out.push({ side: 'LONG', entry: c, fwd: m5.slice(i + 1, i + 1 + HORIZON) });
    } else {
      const stochTurn = prev.k > 75 && prev.k >= prev.d && cur.k < cur.d;
      const buyProxy = barPos < 0.5;
      const aligned = [stochTurn, nearFib, buyProxy].filter(Boolean).length;
      if (aligned >= 1) out.push({ side: 'SHORT', entry: c, fwd: m5.slice(i + 1, i + 1 + HORIZON) });
    }
  }
  return out;
}

function applyExits(sym, entries, model) {
  let wins = 0, losses = 0, net = 0;
  for (const e of entries) {
    let r;
    if (model === 'i') r = simStd(e.side, e.entry, e.fwd, 0.4, 0.4, 0.15, 0.2);
    else if (model === 'ii') r = simStd(e.side, e.entry, e.fwd, 0.6, 0.3, 0.15, 0.3);
    else r = simTrail(e.side, e.entry, e.fwd, 0.2, 0.3, 0.4);
    const pct = (r.px - e.entry) / e.entry * 100 * (e.side === 'LONG' ? 1 : -1);
    const pnl = pct * PNL_PER_PCT - FEE;
    if (pnl > 0) { wins++; net += pnl; } else { losses++; net -= Math.abs(pnl); }
  }
  const trades = wins + losses;
  return { trades, wins, losses, wr: trades ? wins / trades * 100 : 0, net, ci: wilson(wins, trades) };
}

const allEntries = {};
for (const s of SYMS) allEntries[s] = entriesFor(s);

function regimeSplit() {
  const m5 = load('research2/m5_BTCUSDT.json');
  const h1 = load('research2/h1_BTCUSDT.json');
  const bias = htfBias(h1);
  let hi = 0; const split = { BULL: 0, BEAR: 0, FLAT: 0 };
  for (let i = 0; i < m5.length; i++) {
    while (hi < h1.length - 1 && h1[hi + 1].t <= m5[i].t) hi++;
    split[bias[hi]]++;
  }
  return split;
}

const models = ['i', 'ii', 'iii'];
const exits = {};
for (const m of models) {
  const per = SYMS.map(s => {
    const r = applyExits(s, allEntries[s], m);
    return { sym: s, trades: r.trades, wr: +r.wr.toFixed(1), netPnl: +r.net.toFixed(2), ci95: [+r.ci[0].toFixed(1), +r.ci[1].toFixed(1)] };
  });
  let tw = 0, tl = 0, tn = 0, tt = 0;
  per.forEach(p => { tw += p.wr > 0 ? 0 : 0; });
  // recompute totals from raw
  const raw = SYMS.map(s => applyExits(s, allEntries[s], m));
  raw.forEach(r => { tw += r.wins; tl += r.losses; tn += r.net; tt += r.trades; });
  const tWr = tt ? tw / tt * 100 : 0;
  const tCi = wilson(tw, tt);
  exits[m] = {
    perSymbol: per,
    total: { trades: tt, wr: +tWr.toFixed(1), netPnl: +tn.toFixed(2), ci95: [+tCi[0].toFixed(1), +tCi[1].toFixed(1)] }
  };
}

const m5 = load('research2/m5_BTCUSDT.json');
const out = {
  design: 'HTF-bias mean-reversion AT SCALE. 1h EMA50 slope bias (BULL>+0.15%/BEAR<-0.15%, widened). LONG only in BULL, SHORT only in BEAR. 5m entry: StochRSI(14) turn OR fib-near(0.382/0.5/0.618) OR buyRatio proxy(barPos>0.5 BULL / <0.5 BEAR); confluence>=1 (relaxed). 3 exit models on SAME entries. Cap $20 lev5 risk$1 fee 0.04% rt.',
  window: { from: m5[0].t, to: m5[m5.length - 1].t, bars: m5.length },
  regimeSplit: regimeSplit(),
  exits: {
    i: exits.i,
    ii: exits.ii,
    iii: exits.iii
  },
  note: 'Per-bar signals (overlapping positions possible) — matches proto_htf methodology. HORIZON=120 5m bars (10h) to resolve; OPEN at horizon = forced exit at last px. PnL unified via implied notional (0.4%=$1). BTC regime split shown (representative, all syms similar).'
};
fs.writeFileSync('research2/htf_scale.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
