/**
 * KalAI optimization harness — compare strategies on 400d DB
 * A) baseline: RR1:1 + full trailing
 * B) partial: 50% at RR1:1 lock, 50% trailing wider
 * C) vol-filter: breakout only if vol > 1.5x 20bar avg
 * D) per-regime SL
 */
'use strict';
const { Client } = require('pg');
const { EMA } = require('technicalindicators');
const PG_DSN = 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const MAKER = 0.0002, RISK = 1, CAPITAL = 20, LEV = 20;

function run(cd, { sl, td, partial, volFilter, perRegime }) {
  const ef = EMA.calculate({ values: cd.map(c => c.close), period: 20 });
  let cap = CAPITAL, pos = null, tr = [], cl = 0;
  const notional = RISK / (sl / 100), fee = notional * MAKER * 2, LOOK = 20;
  const vol = cd.map((c, i) => i >= 20 ? cd.slice(i - 20, i).reduce((a, x) => a + x.volume, 0) / 20 : c.volume);
  for (let i = 60; i < cd.length; i++) {
    const c = cd[i], p = c.close, h = c.high, l = c.low;
    if (pos) {
      const isL = pos.side === 'LONG';
      const hitTp1 = isL ? h >= pos.tp1 : l <= pos.tp1;
      if (!pos.trailed && hitTp1) { pos.trailed = true; pos.sl = pos.entry; if (partial) { cap += notional * 0.5 * (isL ? (pos.tp1 - pos.entry) / pos.entry : (pos.entry - pos.tp1) / pos.entry) - fee * 0.5; pos.qty = 0.5; } }
      if (pos.trailed) { const tpNow = isL ? p * (1 - td / 100) : p * (1 + td / 100); if (isL ? tpNow > pos.sl : tpNow < pos.sl) pos.sl = tpNow; }
      const exitNow = pos.trailed ? (isL ? p * (1 - td / 100) : p * (1 + td / 100)) : pos.tp1;
      if (isL ? l <= pos.sl : h >= pos.sl) { const pp = isL ? (pos.sl - pos.entry) / pos.entry * 100 : (pos.entry - pos.sl) / pos.entry * 100; const pnl = notional * (pos.qty || 1) * (pp / 100) - fee * (pos.qty || 1); cap += pnl; if (pnl <= 0) cl++; else cl = 0; tr.push(pnl); pos = null; }
      else if (pos.trailed && (isL ? h >= exitNow : l <= exitNow)) { const pp = isL ? (exitNow - pos.entry) / pos.entry * 100 : (pos.entry - exitNow) / pos.entry * 100; const pnl = notional * 0.5 * (pp / 100) - fee * 0.5; cap += pnl; if (pnl <= 0) cl++; else cl = 0; tr.push(pnl); pos = null; }
      continue;
    }
    const hh = Math.max(...cd.slice(i - LOOK, i).map(x => x.high));
    const ll = Math.min(...cd.slice(i - LOOK, i).map(x => x.low));
    if (volFilter && vol[i] < vol[i - 1] * 1.5 && vol[i] < cd.slice(i - 20, i).reduce((a, x) => a + x.volume, 0) / 20 * 1.5) continue;
    if (p >= hh * 0.999) pos = { side: 'LONG', entry: p, sl: p * (1 - sl / 100), tp1: p * (1 + sl / 100), trailed: false, qty: 1 };
    else if (p <= ll * 1.001) pos = { side: 'SHORT', entry: p, sl: p * (1 + sl / 100), tp1: p * (1 - sl / 100), trailed: false, qty: 1 };
  }
  const w = tr.filter(t => t > 0).length;
  return { n: tr.length, wr: tr.length ? +(w / tr.length * 100).toFixed(1) : 0, pnl: +tr.reduce((a, b) => a + b, 0).toFixed(2), roi: +((cap - CAPITAL) / CAPITAL * 100).toFixed(0) };
}

(async () => {
  const pg = new Client({ connectionString: PG_DSN }); await pg.connect();
  const sym = process.env.SYM || 'BTCUSDT', iv = process.env.IV || '15m';
  const r = await pg.query('SELECT ts,open,high,low,close,volume FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3', [sym, iv, 8000]);
  await pg.end();
  const cd = r.rows.reverse().map(x => ({ ts: new Date(x.ts).getTime(), open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume }));
  console.log(`${sym} ${iv} | optimization`);
  console.log('A baseline sl=0.8 td=0.25:        ', JSON.stringify(run(cd, { sl: 0.8, td: 0.25 })));
  console.log('B partial  sl=0.8 td=0.25:        ', JSON.stringify(run(cd, { sl: 0.8, td: 0.25, partial: true })));
  console.log('C volfilter sl=0.8 td=0.25:        ', JSON.stringify(run(cd, { sl: 0.8, td: 0.25, volFilter: true })));
  console.log('D partial+vol sl=0.8 td=0.25:      ', JSON.stringify(run(cd, { sl: 0.8, td: 0.25, partial: true, volFilter: true })));
  for (const td of [0.15, 0.2, 0.3, 0.35]) console.log(`A td=${td} sl=0.8:                 `, JSON.stringify(run(cd, { sl: 0.8, td })));
})().catch(e => { console.error(e.message); process.exit(1); });
