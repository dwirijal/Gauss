// Param sweep: find config with WR>50% on 400d data
const { Client } = require('pg');
const PG_DSN = process.env.PG_DSN || 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const TD = 0.15, SL = 1.0, CAPITAL = 20, RISK_PCT = 2, MIN_RISK = 1;
const FEE = 0.0004;
const RISK = Math.max(CAPITAL * RISK_PCT / 100, MIN_RISK);

function emaArr(closes, p) {
  const k = 2 / (p + 1), e = [closes[0]];
  for (let i = 1; i < closes.length; i++) e.push(closes[i] * k + e[i-1] * (1 - k));
  return e;
}

function test(cd, look, mode, hb, lb) {
  // mode: 'breakout' | 'reversal'
  let w = 0, l = 0, pnl = 0;
  const notional = RISK / (SL / 100);
  const fee = notional * FEE * 2;
  const ema = emaArr(cd.map(c => c.close), 50);
  for (let i = look + 1; i < cd.length; i++) {
    const hh = Math.max(...cd.slice(i - look, i).map(c => c.high));
    const ll = Math.min(...cd.slice(i - look, i).map(c => c.low));
    const c = cd[i].close, o = cd[i].open, h = cd[i].high, lw = cd[i].low;
    let side = null, entry = null;
    if (mode === 'breakout') {
      if (c >= hh * hb) { side = 'L'; entry = c; }
      else if (c <= ll * lb) { side = 'S'; entry = c; }
    } else { // reversal: wick breaks level but close stays inside
      if (lw <= ll * lb && c > ll) { side = 'L'; entry = c; } // swept low, reclaimed
      else if (h >= hh * hb && c < hh) { side = 'S'; entry = c; } // swept high, rejected
    }
    if (!side) continue;
    const slc = side === 'L' ? entry * (1 - SL/100) : entry * (1 + SL/100);
    const tpl = side === 'L' ? entry * (1 + SL/100) : entry * (1 - SL/100);
    let trailed = false;
    for (let j = i + 1; j < Math.min(i + 600, cd.length); j++) {
      const hj = cd[j].high, lj = cd[j].low, cj = cd[j].close;
      if (!trailed) {
        if (side === 'L' ? hj >= tpl : lj <= tpl) { trailed = true; continue; }
      }
      if (trailed) {
        const tpNow = side === 'L' ? cj * (1 - TD/100) : cj * (1 + TD/100);
        if (side === 'L' ? lj <= tpNow : hj >= tpNow) {
          const pp = side === 'L' ? (tpNow - entry)/entry*100 : (entry - tpNow)/entry*100;
          pnl += notional * (pp/100) - fee; if (pp > 0) w++; else l++; break;
        }
      } else {
        if (side === 'L' ? lj <= slc : hj >= slc) {
          const pp = side === 'L' ? (slc - entry)/entry*100 : (entry - slc)/entry*100;
          pnl += notional * (pp/100) - fee; if (pp > 0) w++; else l++; break;
        }
      }
    }
  }
  return { wr: w+l ? +(w/(w+l)*100).toFixed(1) : 0, n: w+l, pnl: +pnl.toFixed(2) };
}

(async () => {
  const pg = new Client({ connectionString: PG_DSN });
  await pg.connect();
  const syms = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const ivs = ['15m', '1h', '4h'];
  const out = [];
  out.push('MODE LOOK | BTC15 ETH15 SOL15 BTC1h ETH1h SOL1h BTC4h ETH4h SOL4h');
  for (const mode of ['breakout', 'reversal']) {
    for (const look of [20, 50]) {
      const cells = [];
      for (const sym of syms) for (const iv of ivs) {
        const r = await pg.query('SELECT close,high,low,open FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3', [sym, iv, 6000]);
        const cd = r.rows.reverse();
        const res = test(cd, look, mode, 0.999, 1.001);
        cells.push(`${res.wr}/${res.n}`);
      }
      out.push(`${mode} ${look} | ${cells.join(' ')}`);
    }
  }
  require('fs').writeFileSync('/tmp/sweep_result.txt', out.join('\n'));
  await pg.end();
})().catch(e => { require('fs').writeFileSync('/tmp/sweep_err.txt', e.message); process.exit(1); });
