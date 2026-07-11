// ponytail: CJS; single-position HTF-bias replay on 90d data. Reads research3/, no network.
'use strict';
const fs = require('fs');
const { EMA } = require('technicalindicators');
const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const DIR = __dirname + '/';

function load(sym, iv) { return JSON.parse(fs.readFileSync(`${DIR}${iv}_${sym}.json`)); }
function wilson(k, n) { if (!n) return [0, 0]; const p = k / n, z = 1.96; const d = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); const c = 1 + z * z / n; return [((p - d / 2) / c) * 100, ((p + d / 2) / c) * 100]; }

function emaSlope(h1) {
  if (h1.length < 70) return null; // per-symbol aligned index, slope vs ~21 bars back
  const v = h1.map((b) => b.c);
  const e = EMA.calculate({ values: v, period: 50 });
  const i = e.length - 1, j = e.length - 21;
  return (e[i] - e[j]) / e[j] * 100;
}
function stochRSI(closes, period = 14, k = 3, d = 3) {
  if (closes.length < period * 2 + k) return null;
  const { StochasticRSI } = require('technicalindicators');
  const r = StochasticRSI.calculate({ values: closes, rsiPeriod: period, stochasticPeriod: period, kPeriod: k, dPeriod: d });
  const last = r[r.length - 1];
  return last ? { k: +last.k.toFixed(1), d: +last.d.toFixed(1) } : null;
}
function fibNear(price, swingH, swingL) {
  if (!swingH || !swingL) return false;
  const rng = swingH - swingL; if (rng <= 0) return false;
  const levels = [0.382, 0.5, 0.618].map((f) => swingL + rng * f);
  return levels.some((lv) => Math.abs(price - lv) / lv < 0.0015);
}

// Exit model (ii): asymmetric TP 0.6 / SL 0.3, trailing 0.15, BE lock @50% TP (mirror simulate()).
function simulate(side, entry, fwd) {
  const tp = side === 'LONG' ? entry * 1.006 : entry * 0.994;
  const sl = side === 'LONG' ? entry * 0.997 : entry * 1.003;
  const TRAIL = 0.15, TPP = 0.6;
  let best = entry, slP = sl, trailed = false;
  for (const k of fwd) {
    const px = k.c;
    best = side === 'LONG' ? Math.max(best, px) : Math.min(best, px);
    const move = side === 'LONG' ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
    if (move >= TPP * 0.5) { const be = side === 'LONG' ? entry * 1.0008 : entry * 0.9992; if (side === 'LONG' ? slP < be : slP > be) slP = be; }
    if (!trailed && move >= TRAIL) trailed = true;
    if (trailed) { const t = side === 'LONG' ? best * (1 - TRAIL / 100) : best * (1 + TRAIL / 100); if (side === 'LONG' ? t > slP : t < slP) slP = t; }
    if (side === 'LONG' ? px >= tp : px <= tp) return 'TP';
    if (side === 'LONG' ? px <= slP : px >= slP) return 'SL';
  }
  return 'OPEN';
}

function run() {
  const out = { design: 'HTF-bias 1h EMA50 slope +/-0.15%, 5m entry, confluence>=1, exit TP0.6/SL0.3 trail0.15 BE@50%, single-position', window: {}, perSymbol: [], total: {} };
  let T = 0, W = 0, net = 0;
  for (const sym of SYMS) {
    const m5 = load(sym, 'm5'), h1 = load(sym, 'h1');
    let wins = 0, losses = 0, pnl = 0, trades = 0;
    const barsIn = [];
    let openPos = null, openEntry = 0, openSide = null, held = 0;
    for (let i = 0; i < m5.length; i++) {
      const c = m5[i].c, v = m5[i].v;
      // HTF bias from 1h at this 5m bar: floor index
      const hIdx = Math.floor(i / 12);
      const slope = emaSlope(h1.slice(0, Math.min(hIdx + 1, h1.length)));
      // confluence>=1
      const closes5 = m5.slice(Math.max(0, i - 60), i + 1).map((b) => b.c);
      const sr = stochRSI(closes5);
      const stochHit = sr && ((sr.k < 25 && sr.k > sr.d) || (sr.k > 75 && sr.k < sr.d));
      const swingH = Math.max(...h1.slice(Math.max(0, hIdx - 20), hIdx + 1).map((b) => b.h));
      const swingL = Math.min(...h1.slice(Math.max(0, hIdx - 20), hIdx + 1).map((b) => b.l));
      const fibHit = fibNear(c, swingH, swingL);
      const buyR = (m5[i].c - m5[i].l) / (m5[i].h - m5[i].l || 1); // close position in bar
      const buyHit = buyR > 0.5;
      const conf = [stochHit, fibHit, buyHit].filter(Boolean).length;
      let want = null;
      if (slope !== null) { if (slope > 0.15) want = 'LONG'; else if (slope < -0.15) want = 'SHORT'; }
      if (openPos) {
        held++;
        const res = simulate(openSide, openEntry, m5.slice(i, i + 1));
        if (res !== 'OPEN') {
          if (res === 'TP') { wins++; pnl += 0.6; } else { losses++; pnl -= 0.3; }
          pnl -= 0.04; // taker rt fee
          trades++; barsIn.push(held);
          openPos = false;
        }
      } else if (want && conf >= 1) {
        openPos = true; openEntry = c; openSide = want; held = 0;
      }
    }
    const wr = trades ? (wins / trades * 100) : 0;
    const [lo, hi] = wilson(wins, trades);
    T += trades; W += wins; net += pnl;
    const med = barsIn.length ? barsIn.sort((a, b) => a - b)[Math.floor(barsIn.length / 2)] : 0;
    out.perSymbol.push({ sym, independentTrades: trades, wr: +wr.toFixed(1), netPnl: +pnl.toFixed(2), ci95: [+lo.toFixed(1), +hi.toFixed(1)], medianBars: med });
  }
  const [lo, hi] = wilson(W, T);
  out.total = { independentTrades: T, wr: +(W / T * 100).toFixed(1), netPnl: +net.toFixed(2), ci95: [+lo.toFixed(1), +hi.toFixed(1)] };
  out.window = { fromISO: new Date(load('BTCUSDT', 'm5')[0].t).toISOString(), toISO: new Date(load('BTCUSDT', 'm5').at(-1).t).toISOString() };
  fs.writeFileSync(`${DIR}htf_90d.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}
run();
