// SIGNAL FAMILY A prototype: HTF-bias mean-reversion. Replays saved bars only (no network).
'use strict';
const fs = require('fs');
const { EMA, StochasticRSI } = require('technicalindicators');

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const TP_OPTS = [0.4, 0.5, 0.75];          // % RR1:1
const TRAIL = 0.15;                         // % trailing stop distance
const FEE_RT = 0.0004;                      // round-trip taker on notional
const CAPITAL = 20, LEV = 5, RISK = 1;      // risk $1/trade
const FIB_TOL = 0.0015;                     // 0.15% near-level tolerance
const FIBS = [0.382, 0.5, 0.618];

const load = f => JSON.parse(fs.readFileSync(f, 'utf8'));

// HTF bias from 1h closes: EMA(50) slope over 21 bars.
function htfBias(h1) {
  const closes = h1.map(b => b.c);
  const ema = EMA.calculate({ values: closes, period: 50 });
  const out = new Array(h1.length).fill('FLAT');
  for (let i = 71; i < h1.length; i++) {
    const slope = (ema[i] - ema[i - 21]) / ema[i - 21] * 100;
    out[i] = slope > 0.3 ? 'BULL' : slope < -0.3 ? 'BEAR' : 'FLAT';
  }
  return out;
}

function stochArr(m5) {
  const closes = m5.map(b => b.c);
  const r = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
  return r.map(x => x ? { k: +x.k.toFixed(1), d: +x.d.toFixed(1) } : null);
}

// last 1h swing high/low within lookback window ending at hIdx
function fibLevels(h1, hIdx) {
  const lo = Math.max(0, hIdx - 19), win = h1.slice(lo, hIdx + 1);
  const hi = Math.max(...win.map(b => b.h)), low = Math.min(...win.map(b => b.l));
  return { hi, low, lvls: FIBS.map(f => low + (hi - low) * f) };
}

// simulate RR1:1 + trailing + BE lock on forward 5m bars
function simulate(side, entry, fwd, tpPct) {
  const tp = side === 'LONG' ? entry * (1 + tpPct / 100) : entry * (1 - tpPct / 100);
  const sl = side === 'LONG' ? entry * (1 - tpPct / 100) : entry * (1 + tpPct / 100);
  let best = entry, slP = sl, trailed = false;
  for (const k of fwd) {
    const px = k.c;
    best = side === 'LONG' ? Math.max(best, px) : Math.min(best, px);
    const move = side === 'LONG' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
    if (move >= tpPct * 0.5) { const be = side === 'LONG' ? entry * 1.0008 : entry * 0.9992; if (side === 'LONG' ? slP < be : slP > be) slP = be; }
    if (!trailed && move >= TRAIL) trailed = true;
    if (trailed) { const t = side === 'LONG' ? best * (1 - TRAIL / 100) : best * (1 + TRAIL / 100); if (side === 'LONG' ? t > slP : t < slP) slP = t; }
    if (side === 'LONG' ? px >= tp : px <= tp) return 'TP';
    if (side === 'LONG' ? px <= slP : px >= slP) return 'SL';
  }
  return 'OPEN';
}

function wilson(wins, n) {
  if (!n) return [0, 0];
  const p = wins / n, z = 1.96;
  const c = p + z * z / (2 * n), d = 1 + z * z / n;
  const s = Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [(c - s) * 100, (c + s) * 100];
}

function runSymbol(sym, tpPct) {
  const m5 = load(`research/m5_${sym}.json`);
  const h1 = load(`research/h1_${sym}.json`);
  const bias = htfBias(h1);
  const st = stochArr(m5);
  const fee = CAPITAL * LEV * FEE_RT;
  let wins = 0, losses = 0, net = 0;
  // map each 5m bar to latest h1 index
  let hi = 0;
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
      if (aligned >= 2) {
        const r = simulate('LONG', c, m5.slice(i + 1), tpPct);
        if (r === 'TP') { wins++; net += RISK - fee; }
        else if (r === 'SL') { losses++; net -= RISK + fee; }
        else { losses++; net -= RISK + fee; } // OPEN at series end = forced exit at loss
      }
    } else if (b === 'BEAR') {
      const stochTurn = prev.k > 75 && prev.k >= prev.d && cur.k < cur.d;
      const buyProxy = barPos < 0.5;
      const aligned = [stochTurn, nearFib, buyProxy].filter(Boolean).length;
      if (aligned >= 2) {
        const r = simulate('SHORT', c, m5.slice(i + 1), tpPct);
        if (r === 'TP') { wins++; net += RISK - fee; }
        else if (r === 'SL') { losses++; net -= RISK + fee; }
        else { losses++; net -= RISK + fee; }
      }
    }
  }
  const trades = wins + losses;
  const wr = trades ? wins / trades * 100 : 0;
  const ci = wilson(wins, trades);
  return { sym, trades, wins, losses, wr, net, ci };
}

const perSymbol = [], totals = { trades: 0, wins: 0, losses: 0, net: 0 };
let best = { tp: null, net: -Infinity };
for (const tp of TP_OPTS) {
  const res = SYMS.map(s => runSymbol(s, tp));
  const tTrades = res.reduce((a, r) => a + r.trades, 0);
  const tWins = res.reduce((a, r) => a + r.wins, 0);
  const tNet = res.reduce((a, r) => a + r.net, 0);
  if (tNet > best.net) best = { tp, net: tNet };
  console.error(`TP=${tp}% -> trades=${tTrades} net=${tNet.toFixed(2)}`);
}

// deterministic best re-run to capture per-symbol at best tp
const bestRes = SYMS.map(s => runSymbol(s, best.tp));
bestRes.forEach(r => { totals.trades += r.trades; totals.wins += r.wins; totals.losses += r.losses; totals.net += r.net; });
const tWr = totals.trades ? totals.wins / totals.trades * 100 : 0;
const tCi = wilson(totals.wins, totals.trades);

const out = {
  design: 'HTF-bias mean-reversion: 1h EMA50 slope bias (BULL>0.3%/BEAR<-0.3%); LONG only in BULL, SHORT only in BEAR. 5m entry: StochRSI(14) turn + fib-near(0.382/0.5/0.618 of last 1h swing) + buyRatio proxy(close pos in bar>0.5). Confluence>=2. Exit RR1:1 TP=SL, trail0.15%, BE@50%TP.',
  params: { capital: CAPITAL, risk: RISK, leverage: LEV, feeRoundTrip: FEE_RT, tpOptions: TP_OPTS, trail: TRAIL, fibTol: FIB_TOL },
  perSymbol: bestRes.map(r => ({ sym: r.sym, trades: r.trades, wr: +r.wr.toFixed(1), netPnl: +r.net.toFixed(2), ci95: [+r.ci[0].toFixed(1), +r.ci[1].toFixed(1)] })),
  best: { tp: best.tp },
  total: { trades: totals.trades, wr: +tWr.toFixed(1), netPnl: +totals.net.toFixed(2), ci95: [+tCi[0].toFixed(1), +tCi[1].toFixed(1)] },
  note: 'HTF bias gated trades; OPEN-at-series-end counted as loss. One position per symbol at a time.'
};
fs.writeFileSync('research/htf_bias.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
