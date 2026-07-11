// Compatible-filter study for counter-trend mean-reversion engine (kalai).
// Reuses score()/simulate() from backtest_live.js (3 pure triggers; depth omitted).
// ponytail: 15m EMA slope defined as % change over last 20 15m bars (~5h) — task under-specified; this is the defensible trend read.
'use strict';
const axios = require('axios');
const { EMA, ATR } = require('technicalindicators');
const S = require('./strategy.js');

const SYMS = (process.env.KALAI_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const TP_PCT = 0.4, SL_PCT = 0.4, TRAIL_DIST = 0.15, GATE = 2;
const LEV = 5, QTY = 1, TAKER = 0.0004; // codebase model (backtest_v3)
const START = 60;
const BASE = 'https://fapi.binance.com';

const CACHE = '/home/dwizzy/dwizzyOS/gauss/kalai/kline_cache';
require('fs').mkdirSync(CACHE, { recursive: true });
function cacheFile(sym) { return `${CACHE}/${sym}.json`; }
function loadCache(sym) { try { return JSON.parse(require('fs').readFileSync(cacheFile(sym),'utf8')); } catch { return null; } }
function saveCache(sym, bars) { require('fs').writeFileSync(cacheFile(sym), JSON.stringify(bars)); }

async function getKlines(sym, endTime) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await axios.get(`${BASE}/fapi/v1/klines`, { params: { symbol: sym, interval: '1m', limit: 1500, endTime }, timeout: 15000 });
      return r.data;
    } catch (e) {
      if (e.response && e.response.status === 429) { await new Promise(r => setTimeout(r, 10000 * (attempt+1))); continue; }
      throw e;
    }
  }
  throw new Error('klines retry exhausted');
}

async function fetch1m(sym, minBars = 4400) {
  const cached = loadCache(sym);
  if (cached && cached.length >= minBars) { console.error(`${sym}: using ${cached.length} cached bars`); return cached; }
  const bars = cached || [];
  let endTime = bars.length ? bars[0].ts - 60000 : Date.now();
  while (bars.length < minBars) {
    const data = await getKlines(sym, endTime); // ponytail: paced via backoff; other kalai procs share IP weight limit
    const chunk = data.map(k => ({ ts: k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] }));
    if (!chunk.length) break;
    for (const b of chunk) bars.push(b); // chunk ascending; dedup+sort at end
    endTime = chunk[0].ts - 60000;
    if (chunk.length < 1500) break;
    process.stderr.write(`  ${sym} ${bars.length} bars\n`);
    await new Promise(r => setTimeout(r, 300)); // pace to avoid 2400/min IP cap
  }
  bars.sort((a,b)=>a.ts-b.ts);
  const seen = new Set(); const dedup = [];
  for (const b of bars) { if (!seen.has(b.ts)) { seen.add(b.ts); dedup.push(b); } }
  saveCache(sym, dedup);
  return dedup;
}

function agg(bars, m) {
  const out = [];
  for (let i = 0; i < bars.length; i += m) {
    const s = bars.slice(i, i+m); if (!s.length) break;
    out.push({ ts: s[0].ts, open: s[0].open, high: Math.max(...s.map(b=>b.high)), low: Math.min(...s.map(b=>b.low)), close: s[s.length-1].close, volume: s.reduce((a,b)=>a+b.volume,0) });
  }
  return out;
}

function score(c) {
  let s = 0;
  const sr = S.stochRSI(c.closes);
  if (sr) { if (sr.k < 25 && sr.k > sr.d) s += 1; else if (sr.k > 75 && sr.k < sr.d) s -= 1; }
  const vw = S.vwap(c.closes, c.volumes);
  const dev = (c.close - vw) / vw * 100;
  if (dev < -0.15) s += 1; else if (dev > 0.15) s -= 1;
  const vs = S.volSpike(c.volumes);
  if (vs.ratio > 1.5) { const hh = Math.max(...c.highs.slice(-10)), ll = Math.min(...c.lows.slice(-10)); if (c.close >= hh*0.9995) s += 1; else if (c.close <= ll*1.0005) s -= 1; }
  return s;
}

function simulate(side, entry, fwd) {
  const tp = side==='LONG' ? entry*(1+TP_PCT/100) : entry*(1-TP_PCT/100);
  const sl = side==='LONG' ? entry*(1-SL_PCT/100) : entry*(1+SL_PCT/100);
  let best = entry, slP = sl, trailed = false;
  for (const k of fwd) {
    const px = k.close;
    best = side==='LONG' ? Math.max(best, px) : Math.min(best, px);
    const move = side==='LONG' ? (px-entry)/entry*100 : (entry-px)/entry*100;
    if (move >= TP_PCT*0.5) { const be = side==='LONG' ? entry*1.0008 : entry*0.9992; if (side==='LONG' ? slP<be : slP>be) slP = be; }
    if (!trailed && move >= TRAIL_DIST) trailed = true;
    if (trailed) { const t = side==='LONG' ? best*(1-TRAIL_DIST/100) : best*(1+TRAIL_DIST/100); if (side==='LONG' ? t>slP : t<slP) slP = t; }
    if (side==='LONG' ? px>=tp : px<=tp) return { res:'TP', exit: tp };
    if (side==='LONG' ? px<=slP : px>=slP) return { res:'SL', exit: slP };
  }
  return { res:'OPEN', exit: entry };
}

function pnl(side, entry, exit) {
  const pct = side==='LONG' ? (exit-entry)/entry : (entry-exit)/entry;
  const notional = QTY * LEV;
  const fee = notional * TAKER * 2;
  return QTY * pct * LEV - fee;
}

function precompute(bars) {
  const highs = bars.map(b=>b.high), lows = bars.map(b=>b.low), closes = bars.map(b=>b.close), vols = bars.map(b=>b.volume), ts = bars.map(b=>b.ts);
  // 15m EMA(50) + slope over 20 15m bars
  const m15 = agg(bars, 15);
  const c15 = m15.map(b=>b.close);
  const ema = EMA.calculate({ values: c15, period: 50 });
  const emaBy1m = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const idx = Math.floor(i/15);
    if (idx < ema.length) emaBy1m[i] = ema[idx];
  }
  const slope15 = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const idx = Math.floor(i/15);
    if (idx >= 20 && ema[idx] && ema[idx-20]) slope15[i] = (ema[idx]-ema[idx-20])/ema[idx-20]*100;
    else if (idx>1 && ema[idx] && ema[idx-1]) slope15[i] = (ema[idx]-ema[idx-1])/ema[idx-1]*100;
  }
  // rolling 20-bar low/high + new extreme within last 5
  const low20 = new Array(bars.length).fill(null), high20 = new Array(bars.length).fill(null);
  const newLow5 = new Array(bars.length).fill(false), newHigh5 = new Array(bars.length).fill(false);
  for (let i = 0; i < bars.length; i++) {
    if (i < 19) continue;
    let lo = Infinity, hi = -Infinity;
    for (let j = i-19; j <= i; j++) { lo = Math.min(lo, lows[j]); hi = Math.max(hi, highs[j]); }
    low20[i] = lo; high20[i] = hi;
    for (let j = Math.max(19, i-4); j <= i; j++) { if (lows[j] <= lo) newLow5[i] = true; if (highs[j] >= hi) newHigh5[i] = true; }
  }
  // 1m ATR(14) %
  const atr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
  const atrPct = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) atrPct[i] = atr[i] ? atr[i]/closes[i]*100 : 0;
  // rolling 100-bar VWAP
  const vwap100 = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const s = Math.max(0, i-99); let pv=0, v=0;
    for (let j=s; j<=i; j++) { pv += closes[j]*vols[j]; v += vols[j]; }
    vwap100[i] = v ? pv/v : closes[i];
  }
  return { slope15, newLow5, newHigh5, atrPct, vwap100, ts };
}

function runSymbol(bars, pc) {
  const zeros = () => ({ t:0,w:0,l:0 });
  const results = { baseline: zeros(), a: zeros(), b: zeros(), c: zeros(), d: zeros(), e: zeros() };
  const pnlAcc = { baseline:0, a:0,b:0,c:0,d:0,e:0 };
  for (let i = START; i < bars.length - 31; i++) {
    const slice = bars.slice(0, i+1);
    const c = { closes: slice.map(b=>b.close), highs: slice.map(b=>b.high), lows: slice.map(b=>b.low), volumes: slice.map(b=>b.volume), close: bars[i].close, high: bars[i].high, low: bars[i].low };
    const sc = score(c);
    const side = sc>=GATE ? 'LONG' : sc<=-GATE ? 'SHORT' : null;
    if (!side) continue;
    const entry = bars[i].close;
    const sim = simulate(side, entry, bars.slice(i+1, i+31));
    if (sim.res === 'OPEN') continue;
    const p = pnl(side, entry, sim.exit);
    // baseline
    results.baseline.t++; if (sim.res==='TP') results.baseline.w++; else results.baseline.l++;
    pnlAcc.baseline += p;
    // (a) 15m EMA slope
    if (side==='LONG' && pc.slope15[i] < -0.3) { /*skip*/ }
    else if (side==='SHORT' && pc.slope15[i] > 0.3) { /*skip*/ }
    else { results.a.t++; if (sim.res==='TP') results.a.w++; else results.a.l++; pnlAcc.a += p; }
    // (b) micro-momentum guard
    if (side==='LONG' && pc.newLow5[i]) { /*skip*/ }
    else if (side==='SHORT' && pc.newHigh5[i]) { /*skip*/ }
    else { results.b.t++; if (sim.res==='TP') results.b.w++; else results.b.l++; pnlAcc.b += p; }
    // (c) volatility gate
    if (pc.atrPct[i] > 0.8) { /*skip*/ }
    else { results.c.t++; if (sim.res==='TP') results.c.w++; else results.c.l++; pnlAcc.c += p; }
    // (d) VWAP distance cap
    const dev = (entry - pc.vwap100[i]) / pc.vwap100[i] * 100;
    if (side==='LONG' && dev > -0.5) { /*skip: not far enough below*/ }
    else if (side==='SHORT' && dev < 0.5) { /*skip: not far enough above*/ }
    else { results.d.t++; if (sim.res==='TP') results.d.w++; else results.d.l++; pnlAcc.d += p; }
    // (e) session 00:00-04:00 UTC
    const h = new Date(pc.ts[i]).getUTCHours();
    if (h < 4) { /*skip*/ }
    else { results.e.t++; if (sim.res==='TP') results.e.w++; else results.e.l++; pnlAcc.e += p; }
  }
  const wr = o => o.t ? +(o.w/o.t*100).toFixed(1) : 0;
  return { baseline:{...results.baseline, wr:wr(results.baseline), pnl:+pnlAcc.baseline.toFixed(3)},
           a:{...results.a, wr:wr(results.a), pnl:+pnlAcc.a.toFixed(3)},
           b:{...results.b, wr:wr(results.b), pnl:+pnlAcc.b.toFixed(3)},
           c:{...results.c, wr:wr(results.c), pnl:+pnlAcc.c.toFixed(3)},
           d:{...results.d, wr:wr(results.d), pnl:+pnlAcc.d.toFixed(3)},
           e:{...results.e, wr:wr(results.e), pnl:+pnlAcc.e.toFixed(3)} };
}

(async () => {
  const out = {};
  for (const sym of SYMS) {
    console.error(`fetching ${sym}...`);
    const bars = await fetch1m(sym);
    const pc = precompute(bars);
    out[sym] = { bars: bars.length, range: [new Date(bars[0].ts).toISOString(), new Date(bars[bars.length-1].ts).toISOString()], ...runSymbol(bars, pc) };
    console.error(`${sym} done: ${out[sym].baseline.t} trades`);
  }
  // aggregate
  const baseTotal = SYMS.reduce((a,s)=>a+out[s].baseline.t,0);
  const aggKey = (k) => { const o={t:0,w:0,l:0,pnl:0}; for (const s of SYMS){ const x=out[s][k]; o.t+=x.t; o.w+=x.w; o.l+=x.l; o.pnl+=x.pnl; } o.wr=+(o.w/o.t*100).toFixed(1); o.pnl=+o.pnl.toFixed(3); o.retained=+(o.t/baseTotal*100).toFixed(1); return o; };
  const summary = { baseline: aggKey('baseline'), a: aggKey('a'), b: aggKey('b'), c: aggKey('c'), d: aggKey('d'), e: aggKey('e') };
  // delta vs baseline
  const d = k => ({ retained_pct: summary[k].retained, wr_pp: +(summary[k].wr - summary.baseline.wr).toFixed(1), pnl_delta: +(summary[k].pnl - summary.baseline.pnl).toFixed(3) });
  summary.delta = { a:d('a'), b:d('b'), c:d('c'), d:d('d'), e:d('e') };
  const final = { range: out[SYMS[0]].range, perSymbol: out, summary };
  require('fs').writeFileSync('/home/dwizzy/dwizzyOS/gauss/kalai/wr_study_filters.json', JSON.stringify(final, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
