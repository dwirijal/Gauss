/**
 * Breakout strategy test — RR 1:1 + trailing
 */
'use strict';
const { Client } = require('pg');

const PG_DSN = 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';

function test(cd, look, sl, trailAct, trailDist) {
  let w = 0, l = 0;
  for (let i = look + 1; i < cd.length; i++) {
    const hh = Math.max(...cd.slice(i - look, i).map(c => c.high));
    const ll = Math.min(...cd.slice(i - look, i).map(c => c.low));
    const p = cd[i].close;
    let side = null, entry = p, slc;
    if (p >= hh * 0.999) { side = 'L'; slc = p * (1 - sl / 100); }
    else if (p <= ll * 1.001) { side = 'S'; slc = p * (1 + sl / 100); }
    else continue;
    let trailed = false;
    for (let j = i + 1; j < Math.min(i + 400, cd.length); j++) {
      const pj = cd[j].close;
      const pp = side === 'L' ? (pj - entry) / entry * 100 : (entry - pj) / entry * 100;
      if (!trailed && pp >= trailAct) trailed = true;
      if (trailed) {
        const ns = side === 'L' ? pj * (1 - trailDist / 100) : pj * (1 + trailDist / 100);
        if (side === 'L' ? ns > slc : ns < slc) slc = ns;
      }
      if (side === 'L') {
        if (pj >= entry * (1 + sl / 100)) { w++; break; }
        if (cd[j].low <= slc) { l++; break; }
      } else {
        if (pj <= entry * (1 - sl / 100)) { w++; break; }
        if (cd[j].high >= slc) { l++; break; }
      }
    }
  }
  return { wr: +((w / (w + l)) * 100).toFixed(1), n: w + l, w, l };
}

(async () => {
  const pg = new Client({ connectionString: PG_DSN }); await pg.connect();
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['15m', '1h', '4h']) {
      const r = await pg.query('SELECT close,high,low FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3', [sym, iv, 6000]);
      const cd = r.rows.reverse();
      const t15 = test(cd, 20, 0.5, 0.3, 0.15);
      console.log(`${sym} ${iv} RR1:1 brk20 sl0.5: WR=${t15.wr}% N=${t15.n}`);
    }
  }
  await pg.end();
})().catch(e => { console.error(e.message); process.exit(1); });
