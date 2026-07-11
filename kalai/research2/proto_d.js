// Proto D: HTF-bias mean-reversion, SINGLE-POSITION (corrects Proto C overlap).
// Identical entry/exit/money to Proto C EXCEPT: at most ONE open position per symbol.
// No network. Reuses proto_c.js entry logic (slope 0.15%, confluence>=1) + exit model ii.
'use strict';
const fs = require('fs');
const { EMA, StochasticRSI } = require('technicalindicators');

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CAPITAL = 20, LEV = 5, RISK = 1, FEE_RT = 0.0004;
const FEE = CAPITAL * LEV * FEE_RT;          // 0.04 round-trip taker on notional
const PNL_PER_PCT = RISK / 0.4;              // 2.5 — keep Proto C money model for comparability
const FIB_TOL = 0.0015, FIBS = [0.382, 0.5, 0.618];
const SLOPE_TH = 0.15;                        // widened, per Proto C

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
// exit model ii: asymmetric TP 0.6 / SL 0.3, trail 0.15, BE lock at 50% TP. Returns bars held.
function simExit(side, entry, fwd, tpPct, slPct, trailPct, beLockAt) {
  const tp = side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = side === 'LONG' ? entry * (1 - slPct / 100) : entry * (1 + slPct / 100);
  let best = entry, slP = sl, trailed = false;
  for (let j = 0; j < fwd.length; j++) {
    const px = fwd[j].c;
    best = side === 'LONG' ? Math.max(best, px) : Math.min(best, px);
    const move = side === 'LONG' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
    if (beLockAt && move >= beLockAt) { const be = side === 'LONG' ? entry * 1.0008 : entry * 0.9992; if (side === 'LONG' ? slP < be : slP > be) slP = be; }
    if (!trailed && move >= trailPct) trailed = true;
    if (trailed) { const t = side === 'LONG' ? best * (1 - trailPct / 100) : best * (1 + trailPct / 100); if (side === 'LONG' ? t > slP : t < slP) slP = t; }
    if (side === 'LONG' ? px >= tp : px <= tp) return { out: 'TP', px: tp, bars: j + 1 };
    if (side === 'LONG' ? px <= slP : px >= slP) return { out: 'SL', px: slP, bars: j + 1 };
  }
  return { out: 'OPEN', px: fwd.length ? fwd[fwd.length - 1].c : entry, bars: fwd.length };
}
function wilson(wins, n) {
  if (!n) return [0, 0];
  const p = wins / n, z = 1.96;
  const c = p + z * z / (2 * n), d = 1 + z * z / n;
  const s = Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [(c - s) * 100, (c + s) * 100];
}
function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// SINGLE-POSITION state machine per symbol.
function runSymbol(sym) {
  const m5 = load(`research2/m5_${sym}.json`);
  const h1 = load(`research2/h1_${sym}.json`);
  const bias = htfBias(h1);
  const st = stochArr(m5);
  let hi = 0, wins = 0, losses = 0, net = 0, cooldown = 0;
  const holds = [];
  for (let i = 31; i < m5.length - 1; i++) {
    while (hi < h1.length - 1 && h1[hi + 1].t <= m5[i].t) hi++;
    if (cooldown > 0) { cooldown--; continue; } // ponytail: position still open; wait for it to close
    const b = bias[hi];
    if (b === 'FLAT') continue;
    if (i < 1 || !st[i] || !st[i - 1]) continue;
    const cur = st[i], prev = st[i - 1];
    const o = m5[i], c = o.c, barPos = o.h > o.l ? (c - o.l) / (o.h - o.l) : 0.5;
    const fib = fibLevels(h1, hi);
    const nearFib = fib.lvls.some(lv => Math.abs(c - lv) / c < FIB_TOL);
    let side = null;
    if (b === 'BULL') {
      const stochTurn = prev.k < 25 && prev.k <= prev.d && cur.k > cur.d;
      const buyProxy = barPos > 0.5;
      const aligned = [stochTurn, nearFib, buyProxy].filter(Boolean).length;
      if (aligned >= 1) side = 'LONG';
    } else {
      const stochTurn = prev.k > 75 && prev.k >= prev.d && cur.k < cur.d;
      const buyProxy = barPos < 0.5;
      const aligned = [stochTurn, nearFib, buyProxy].filter(Boolean).length;
      if (aligned >= 1) side = 'SHORT';
    }
    if (!side) continue;
    const r = simExit(side, c, m5.slice(i + 1), 0.6, 0.3, 0.15, 0.3);
    holds.push(r.bars);
    const pct = (r.px - c) / c * 100 * (side === 'LONG' ? 1 : -1);
    const pnl = pct * PNL_PER_PCT - FEE;
    if (pnl > 0) { wins++; net += pnl; } else { losses++; net -= Math.abs(pnl); }
    cooldown = r.bars;                          // block new entries for the bars this position lived
  }
  const trades = wins + losses;
  return {
    sym, independentTrades: trades, wins, losses,
    wr: trades ? +(wins / trades * 100).toFixed(1) : 0,
    netPnl: +net.toFixed(2),
    ci95: wilson(wins, trades).map(x => +x.toFixed(1)),
    medianBars: +median(holds).toFixed(1)
  };
}

const perSymbol = SYMS.map(runSymbol);
let tw = 0, tl = 0, tn = 0, tt = 0;
perSymbol.forEach(r => { tw += r.wins; tl += r.losses; tn += r.netPnl; tt += r.independentTrades; });
const tWr = tt ? +(tw / tt * 100).toFixed(1) : 0;
const tCi = wilson(tw, tt).map(x => +x.toFixed(1));
const m5 = load('research2/m5_BTCUSDT.json');

// Proto C model ii baseline for compare
const pc = JSON.parse(fs.readFileSync('research2/htf_scale.json', 'utf8')).exits.ii;
const protoC_compare = {};
SYMS.forEach((s, k) => {
  protoC_compare[s] = { protoC_trades: pc.perSymbol[k].trades, protoC_wr: pc.perSymbol[k].wr };
});

const out = {
  design: 'HTF-bias mean-reversion, SINGLE-POSITION (fixes Proto C overlap). 1h EMA50 slope (BULL>+0.15%/BEAR<-0.15%); 5m entry StochRSI(14) turn OR fib-near OR barPos proxy, confluence>=1. Max ONE open position/symbol: open at 5m close, exit model ii (TP0.6/SL0.3/trail0.15/BE@50%TP) on 5m bars, no new entry until closed. Cap$20 lev5 risk$1 fee0.04%rt. Same money/entry/exit as Proto C — only position-count differs.',
  window: { from: m5[0].t, to: m5[m5.length - 1].t, bars: m5.length, approxDays: +(m5.length * 5 / (60 * 24)).toFixed(1) },
  perSymbol: perSymbol.map(r => ({ sym: r.sym, independentTrades: r.independentTrades, wr: r.wr, netPnl: r.netPnl, ci95: r.ci95, medianBars: r.medianBars })),
  total: { independentTrades: tt, wr: tWr, netPnl: +tn.toFixed(2), ci95: tCi },
  protoC_compare,
  note: 'Proto C (overlapping) vs Proto D (independent) on identical signals. Single-position cuts trade count ~95%+. Holding bars median drives how many independent trades a window yields.'
};
fs.writeFileSync('research2/htf_singlepos.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
