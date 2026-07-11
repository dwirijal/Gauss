/**
 * KalAI Scalper v2 — correct notional sizing
 * Risk ($) = Notional x SL%  =>  Notional = RISK / SL%
 * Fee      = Notional x FeeRate x 2 (open+close)
 * Leverage = max platform (margin = notional/lev, just capital efficiency)
 */
'use strict';
const { Client } = require('pg');
const { RSI, EMA } = require('technicalindicators');

const PG_DSN = process.env.PG_DSN || 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const SYMBOL = process.env.SYM || 'BTCUSDT';
const INTERVAL = process.env.IV || '15m';
const LIMIT = parseInt(process.env.LIMIT || '10000', 10);

const LEVERAGE = parseInt(process.env.LEV || '20', 10);   // max platform
const MAKER = parseFloat(process.env.FEE || '0.0002');    // 0.02%
const TAKER = 0.0005;                                     // 0.05% (user spec)
const RISK = parseFloat(process.env.RISK || '1', 10);     // $1/trade
const CAPITAL = 20;

function bt(cd, cfg) {
  let cap = CAPITAL, pos = null, tr = [], cl = 0, paused = 0, li = 0;
  const ef = EMA.calculate({ values: cd.map(c => c.close), period: cfg.emaF });
  const es = EMA.calculate({ values: cd.map(c => c.close), period: cfg.emaS });
  const rsi = RSI.calculate({ values: cd.map(c => c.close), period: 14 });
  const notional = RISK / (cfg.sl / 100);              // <- correct sizing
  const feeRate = cfg.maker ? MAKER : TAKER;
  for (let i = cfg.emaS + 5; i < cd.length; i++) {
    li = i; const c = cd[i], p = c.close, h = c.high, l = c.low;
    if (pos) {
      const isL = pos.side === 'LONG';
      const pp = isL ? (p - pos.entry) / pos.entry * 100 : (pos.entry - p) / pos.entry * 100;
      // trailing: once price moves trailAct in favor, tighten SL to trailDist behind
      if (!pos.trailed && pp >= cfg.trailAct) { pos.trailed = true; }
      if (pos.trailed) {
        if (isL) { const ns = p*(1-cfg.trailDist/100); if (ns > pos.sl) pos.sl = ns; }
        else { const ns = p*(1+cfg.trailDist/100); if (ns < pos.sl) pos.sl = ns; }
      }
      const fee = notional * feeRate * 2;
      if (pp >= cfg.tp) { const pnl = notional * (cfg.tp/100) - fee; cap += pnl; if (pnl<=0){cl++;} else cl=0; tr.push(pnl); pos=null; }
      else if (isL ? l <= pos.sl : h >= pos.sl) { const pnl = -RISK - fee; cap += pnl; if (pnl<=0){cl++; if(cl>=3) paused=li+Math.round(60/cfg.minPer);} else cl=0; tr.push(pnl); pos=null; }
      continue;
    }
    if (i < paused) continue;
    const eF = ef[i], eS = es[i], r = rsi[i];
    if (!eF || !eS || !r) continue;
    if (eF > eS && p <= eF*(1+cfg.pb) && p > eS*0.999 && r > cfg.rsiLo && r < cfg.rsiHi) {
      pos = { side:'LONG', entry:p, sl: p*(1-cfg.sl/100), best:p, trailed:false };
    } else if (eF < eS && p >= eF*(1-cfg.pb) && p < eS*1.001 && r < (100-cfg.rsiLo) && r > (100-cfg.rsiHi)) {
      pos = { side:'SHORT', entry:p, sl: p*(1+cfg.sl/100), best:p, trailed:false };
    }
  }
  const w = tr.filter(t => t > 0).length;
  return { n: tr.length, wr: tr.length ? +(w/tr.length*100).toFixed(1) : 0, pnl: +tr.reduce((a,b)=>a+b,0).toFixed(2), notional:+notional.toFixed(1) };
}

(async () => {
  const pg = new Client({ connectionString: PG_DSN }); await pg.connect();
  const r = await pg.query('SELECT ts,open,high,low,close,volume FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3', [SYMBOL, INTERVAL, LIMIT]);
  await pg.end();
  const cd = r.rows.reverse().map(x => ({ ts:new Date(x.ts).getTime(), open:x.open, high:x.high, low:x.low, close:x.close, volume:x.volume }));
  const cfg = {
    emaF: parseInt(process.env.EMA_F||'20',10), emaS: parseInt(process.env.EMA_S||'50',10),
    pb: parseFloat(process.env.PB||'0.001',10), rsiLo: parseFloat(process.env.RSI_LO||'40',10), rsiHi: parseFloat(process.env.RSI_HI||'65',10),
    tp: parseFloat(process.env.TP||'0.5',10), sl: parseFloat(process.env.SL||'1.5',10),
    minPer: parseInt(process.env.MIN_PER||'15',10), maker: process.env.MAKER!=='0',
    trailAct: parseFloat(process.env.TRAIL_ACT||'0.3',10), trailDist: parseFloat(process.env.TRAIL_DIST||'0.15',10),
  };
  const res = bt(cd, cfg);
  console.log(`${SYMBOL} ${INTERVAL} | lev=${LEVERAGE} maker=${cfg.maker} | notional=$${res.notional} fee/trade=$${(res.notional*(cfg.maker?MAKER:TAKER)*2).toFixed(4)}`);
  console.log(`CFG tp=${cfg.tp} sl=${cfg.sl}`);
  console.log(`WR=${res.wr}%  N=${res.n}  PnL=$${res.pnl}  (ROI ${(res.pnl/CAPITAL*100).toFixed(0)}%)`);
})().catch(e => { console.error(e.message); process.exit(1); });
