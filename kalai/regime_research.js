/**
 * Adaptive regime research — find best scalping params per market state
 * Regimes: BULL (ema50 up + low vol), BEAR (ema50 down + low vol), CHOPPY (high vol / sideways)
 * Rule: risk max 2% or $1 min. Gain-maximizing params per regime.
 */
'use strict';
const { Client } = require('pg');
const { EMA } = require('technicalindicators');

const PG_DSN = 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const LEV = 20, MAKER = 0.0002;
const RISK = 1, CAPITAL = 20, TRAIL = 0.25;

function regimeOf(closes, i, ema50, atr) {
  const slope = (ema50[i] - ema50[i - 20]) / ema50[i - 20] * 100;
  const vol = atr[i] / closes[i] * 100;
  if (vol > 0.8) return 'CHOPPY';
  if (slope > 0.3) return 'BULL';
  if (slope < -0.3) return 'BEAR';
  return 'CHOPPY';
}

function bt(cd, cfg, regimeFilter) {
  let cap = CAPITAL, pos = null, tr = [], cl = 0, paused = 0, li = 0;
  const ef = EMA.calculate({ values: cd.map(c => c.close), period: 20 });
  const e50 = EMA.calculate({ values: cd.map(c => c.close), period: 50 });
  const atr = [];
  for (let i = 1; i < cd.length; i++) atr.push(Math.max(cd[i].high - cd[i].low, Math.abs(cd[i].high - cd[i - 1].close), Math.abs(cd[i].low - cd[i - 1].close)));
  const notional = RISK / (cfg.sl / 100);
  const fee = notional * MAKER * 2;
  const LOOK = 20;
  for (let i = 60; i < cd.length; i++) {
    li = i; const c = cd[i], p = c.close, h = c.high, l = c.low;
    const reg = regimeOf(cd.map(x => x.close), i, e50, atr);
    if (pos) {
      const isL = pos.side === 'LONG';
      const hitTp1 = isL ? h >= pos.tp1 : l <= pos.tp1;
      if (!pos.trailed && hitTp1) { pos.trailed = true; pos.sl = pos.entry; }
      if (pos.trailed) { const tpNow = isL ? p * (1 - TRAIL / 100) : p * (1 + TRAIL / 100); if (isL ? tpNow > pos.sl : tpNow < pos.sl) pos.sl = tpNow; }
      const tpNow = pos.trailed ? (isL ? p * (1 - TRAIL / 100) : p * (1 + TRAIL / 100)) : pos.tp1;
      if (isL ? l <= pos.sl : h >= pos.sl) {
        const exit = Math.max(pos.sl, isL ? Math.min(l, pos.sl) : Math.max(h, pos.sl));
        const pp = isL ? (pos.sl - pos.entry) / pos.entry * 100 : (pos.entry - pos.sl) / pos.entry * 100;
        const pnl = notional * (pp / 100) - fee; cap += pnl; if (pnl <= 0) cl++; else cl = 0; tr.push(pnl); pos = null;
      } else if (pos.trailed && (isL ? h >= tpNow : l <= tpNow)) {
        const pp = isL ? (tpNow - pos.entry) / pos.entry * 100 : (pos.entry - tpNow) / pos.entry * 100;
        const pnl = notional * (pp / 100) - fee; cap += pnl; if (pnl <= 0) cl++; else cl = 0; tr.push(pnl); pos = null;
      }
      continue;
    }
    if (i < paused) continue;
    if (regimeFilter && reg !== regimeFilter) continue;
    const hh = Math.max(...cd.slice(i - LOOK, i).map(x => x.high));
    const ll = Math.min(...cd.slice(i - LOOK, i).map(x => x.low));
    if (p >= hh * 0.999) pos = { side: 'LONG', entry: p, sl: p * (1 - cfg.sl / 100), tp1: p * (1 + cfg.sl / 100), trailed: false };
    else if (p <= ll * 1.001) pos = { side: 'SHORT', entry: p, sl: p * (1 + cfg.sl / 100), tp1: p * (1 - cfg.sl / 100), trailed: false };
  }
  const w = tr.filter(t => t > 0).length;
  return { n: tr.length, wr: tr.length ? +(w / tr.length * 100).toFixed(1) : 0, pnl: +tr.reduce((a, b) => a + b, 0).toFixed(2) };
}

(async () => {
  const pg = new Client({ connectionString: PG_DSN }); await pg.connect();
  const sym = process.env.SYM || 'BTCUSDT';
  const iv = process.env.IV || '15m';
  const r = await pg.query('SELECT ts,open,high,low,close,volume FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3', [sym, iv, 8000]);
  await pg.end();
  const cd = r.rows.reverse().map(x => ({ ts: new Date(x.ts).getTime(), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
  console.log(`${sym} ${iv} | regimes research`);
  for (const reg of ['BULL', 'BEAR', 'CHOPPY']) {
    let best = null;
    for (const sl of [0.3, 0.5, 0.8]) {
      const res = bt(cd, { sl }, reg);
      if (res.n >= 10 && (!best || res.pnl > best.pnl)) best = { sl, ...res };
    }
    console.log(`${reg}: ${best ? `sl=${best.sl} WR=${best.wr}% N=${best.n} PnL=$${best.pnl}` : 'no trades'}`);
  }
  // combined (all regimes, adaptive = pick best sl per regime at runtime)
  const combined = bt(cd, { sl: 0.5 }, null);
  console.log(`ALL (sl=0.5 fixed): WR=${combined.wr}% N=${combined.n} PnL=$${combined.pnl}`);
  await pg.end();
})().catch(e => { console.error(e.message); process.exit(1); });
