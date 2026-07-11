// Tick-level backtester — mirrors live bot: breakout on intra-candle high/low
// Entry fires when candle HIGH crosses 20-bar-high (LONG) or LOW crosses 20-bar-low (SHORT)
// Entry price = breakout level (hh or ll). RR1:1 + trailing (td). SL=sl%.
const { Client } = require('pg');
const PG_DSN = process.env.PG_DSN || 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const TD = parseFloat(process.env.TD || '0.15');
const SL = parseFloat(process.env.SL || '1.0');
const CAPITAL = 20, RISK_PCT = 2, MIN_RISK = 1;
const MAKER = 0.0002, TAKER = 0.0004;          // live: entry MARKET (taker), exit MARKET (taker)
const FEE_RATE = TAKER;                          // both legs taker in live
const RISK = Math.max(CAPITAL * RISK_PCT / 100, MIN_RISK); // $1

function test(cd, look, sl, td) {
  let w = 0, l = 0, pnl = 0;
  const notional = RISK / (sl / 100);
  const fee = notional * FEE_RATE * 2;
  for (let i = look + 1; i < cd.length; i++) {
    const hh = Math.max(...cd.slice(i - look, i).map(c => c.high));
    const ll = Math.min(...cd.slice(i - look, i).map(c => c.low));
    const c = cd[i].close; // live-updated close (tick-level body breakout, matches live bot)
    let side = null, entry = null;
    const HB = parseFloat(process.env.HB || '0.999'), LB = parseFloat(process.env.LB || '1.001');
    if (c >= hh * HB) { side = 'L'; entry = c; }
    else if (c <= ll * LB) { side = 'S'; entry = c; }
    else continue;
    const slc = side === 'L' ? entry * (1 - sl / 100) : entry * (1 + sl / 100);
    const tpl = side === 'L' ? entry * (1 + sl / 100) : entry * (1 - sl / 100); // RR1:1
    let trailed = false, qtyLeft = 1;
    for (let j = i + 1; j < Math.min(i + 600, cd.length); j++) {
      const hj = cd[j].high, lj = cd[j].low, cj = cd[j].close;
      if (!trailed) {
        const hitTp1 = side === 'L' ? hj >= tpl : lj <= tpl;
        if (hitTp1) { trailed = true; continue; }
      }
      if (trailed) {
        const tpNow = side === 'L' ? cj * (1 - td / 100) : cj * (1 + td / 100);
        const hitTrail = side === 'L' ? lj <= tpNow : hj >= tpNow;
        if (hitTrail) {
          const exit = tpNow;
          const pp = side === 'L' ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
          pnl += notional * qtyLeft * (pp / 100) - fee; if (pp > 0) w++; else l++; break;
        }
      } else {
        const hitSl = side === 'L' ? lj <= slc : hj >= slc;
        if (hitSl) {
          const pp = side === 'L' ? (slc - entry) / entry * 100 : (entry - slc) / entry * 100;
          pnl += notional * qtyLeft * (pp / 100) - fee; if (pp > 0) w++; else l++; break;
        }
      }
    }
  }
  return { wr: +((w / (w + l)) * 100).toFixed(1), n: w + l, pnl: +pnl.toFixed(2) };
}

(async () => {
  const pg = new Client({ connectionString: PG_DSN }); await pg.connect();
  console.log(`TICK-LEVEL backtest | SL=${SL}% TD=${TD}% | live fee model (taker both legs) | CAPITAL=$${CAPITAL} risk=$${RISK}`);
  const tot = await pg.query('SELECT COUNT(*) c FROM market_data');
  console.log('DB TOTAL ROWS:', tot.rows[0].c);
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['15m', '1h', '4h']) {
      const r = await pg.query('SELECT COUNT(*) c FROM market_data WHERE symbol=$1 AND interval=$2', [sym, iv]);
      console.log(`  ${sym} ${iv}: n=${r.rows[0].c}`);
    }
  }
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['15m', '1h', '4h']) {
      const r = await pg.query('SELECT close,high,low FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3', [sym, iv, 6000]);
      const cd = r.rows.reverse();
      const res = test(cd, 20, SL, TD);
      console.log(`${sym} ${iv}: WR=${res.wr}% N=${res.n} PnL=$${res.pnl}`);
    }
  }
  await pg.end();
})().catch(e => { console.error(e.message); process.exit(1); });
