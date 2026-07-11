'use strict';
// Counter-trend 1m WR sweep. Reuses strategy.js pure-trigger scoring; mirrors
// backtest_live.js exit (RR1:1 or asymmetric TP/SL + trailing + BE lock @50% TP).
// Depth/orderbook trigger omitted (no historical L2). ponytail: fee = 0.04% rt per task.
const fs = require('fs');
const https = require('https');
const S = require('./strategy.js');

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const CAPITAL = 20, RISK = 1, LEV = 5;
const FEE_RT = 0.0004;               // 0.04% round trip (taker)
const HORIZON = 720;                 // 12h max hold per trade
const WARMUP = 60;
const CACHE = '/tmp/kalai_klines_1m.json';
const BASE = 'https://fapi.binance.com';

function get(sym, startTime) {
  return new Promise((res, rej) => {
    const q = `symbol=${sym}&interval=1m&limit=1500${startTime ? `&startTime=${startTime}` : ''}`;
    https.get(`${BASE}/fapi/v1/klines?${q}`, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        try { res(JSON.parse(d).map(k => ({ o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5], t:k[0] }))); }
        catch (e) { rej(e); }
      });
    }).on('error', rej);
  });
}

async function fetchSym(sym) {
  const now = Date.now();
  let start = now - 4 * 24 * 3600 * 1000;   // ~4 days back
  const map = new Map();
  let guard = 0;
  while (guard++ < 30) {
    const batch = await get(sym, start);    // ascending from startTime, limit 1500
    if (!batch.length) break;
    for (const b of batch) map.set(b.t, b);
    const lastT = batch[batch.length - 1].t;
    if (lastT >= now - 60000) break;
    start = lastT + 60000;
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function precompute(k) {
  const n = k.length, closes = k.map(x => x.c), highs = k.map(x => x.h), lows = k.map(x => x.l), vols = k.map(x => x.v);
  const srK = new Array(n).fill(null), srD = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const sr = S.stochRSI(closes.slice(0, i + 1));
    if (sr) { srK[i] = sr.k; srD[i] = sr.d; }
  }
  const cumPV = new Array(n), cumV = new Array(n);
  for (let i = 0; i < n; i++) {
    cumPV[i] = (i ? cumPV[i - 1] : 0) + closes[i] * vols[i];
    cumV[i] = (i ? cumV[i - 1] : 0) + vols[i];
  }
  const dev = new Array(n);
  for (let i = 0; i < n; i++) { const vw = cumPV[i] / cumV[i]; dev[i] = (closes[i] - vw) / vw * 100; }
  const volR = new Array(n), hh10 = new Array(n), ll10 = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 19), seg = vols.slice(a, i + 1), avg = seg.reduce((p, x) => p + x, 0) / seg.length;
    volR[i] = avg ? vols[i] / avg : 1;
    hh10[i] = Math.max(...highs.slice(a, i + 1));
    ll10[i] = Math.min(...lows.slice(a, i + 1));
  }
  const score = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    if (srK[i] != null) {
      if (srK[i] < 25 && srK[i] > srD[i]) s += 1;
      else if (srK[i] > 75 && srK[i] < srD[i]) s -= 1;
    }
    if (dev[i] < -0.15) s += 1; else if (dev[i] > 0.15) s -= 1;
    if (volR[i] > 1.5) { if (closes[i] >= hh10[i] * 0.9995) s += 1; else if (closes[i] <= ll10[i] * 1.0005) s -= 1; }
    score[i] = s;
  }
  return { closes, score, n };
}

function simulate(pc, i, TP, SL, TRAIL) {
  const entry = pc.closes[i];
  const LONG = pc.score[i] >= 0;
  const tp = LONG ? entry * (1 + TP / 100) : entry * (1 - TP / 100);
  const sl = LONG ? entry * (1 - SL / 100) : entry * (1 + SL / 100);
  let best = entry, slP = sl, trailed = false;
  const end = Math.min(i + HORIZON, pc.n);
  for (let j = i + 1; j < end; j++) {
    const px = pc.closes[j];
    best = LONG ? Math.max(best, px) : Math.min(best, px);
    const move = LONG ? (px - entry) / entry * 100 : (entry - px) / entry * 100;
    if (move >= TP * 0.5) { const be = LONG ? entry * 1.0008 : entry * 0.9992; if (LONG ? slP < be : slP > be) slP = be; }
    if (!trailed && move >= TRAIL) trailed = true;
    if (trailed) { const t = LONG ? best * (1 - TRAIL / 100) : best * (1 + TRAIL / 100); if (LONG ? t > slP : t < slP) slP = t; }
    if (LONG ? px >= tp : px <= tp) return { r: 'TP', exit: tp };
    if (LONG ? px <= slP : px >= slP) return { r: 'SL', exit: slP };
  }
  return { r: 'OPEN', exit: null };
}

function runCombo(syms, gate, TP, SL, TRAIL) {
  let w = 0, l = 0, pnl = 0, open = 0, trades = 0;
  const per = {};
  for (const sym of syms) {
    const pc = sym.pc, sc = pc.score;
    let sw = 0, sl_ = 0, sopen = 0, spnl = 0;
    for (let i = WARMUP; i < pc.n - HORIZON; i++) {
      const s = sc[i];
      if (s < gate && s > -gate) continue;
      const LONG = s >= gate;
      const r = simulate(pc, i, TP, SL, TRAIL);
      if (r.r === 'OPEN') { open++; sopen++; continue; }
      trades++;
      const entry = pc.closes[i];
      const move = LONG ? (r.exit - entry) / entry * 100 : (entry - r.exit) / entry * 100;
      const notional = RISK / (SL / 100);
      const fee = notional * FEE_RT;
      const tradePnl = notional * (move / 100) - fee;
      pnl += tradePnl; spnl += tradePnl;
      if (r.r === 'TP') { w++; sw++; } else { l++; sl_++; }
    }
    per[sym.sym] = { trades: sw + sl_ + sopen, win: sw, loss: sl_, open: sopen, wr: (sw + sl_) ? +(sw / (sw + sl_) * 100).toFixed(1) : 0, pnl: +spnl.toFixed(2) };
  }
  return {
    gate, tp: TP, sl: SL, trail: TRAIL,
    trades, win: w, loss: l, open,
    wr: (w + l) ? +(w / (w + l) * 100).toFixed(1) : 0,
    netPnl: +pnl.toFixed(2),
    liveCompatible: gate === 2,
    perSymbol: per,
  };
}

(async () => {
  let cache = {};
  if (fs.existsSync(CACHE)) { try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) {} }
  const syms = [];
  for (const sym of SYMS) {
    if (!cache[sym]) { console.error('fetch', sym); cache[sym] = await fetchSym(sym); }
    const k = cache[sym];
    console.error(`${sym}: ${k.length} bars ${new Date(k[0].t).toISOString()}..${new Date(k[k.length-1].t).toISOString()}`);
    syms.push({ sym, pc: precompute(k), k });
  }
  fs.writeFileSync(CACHE, JSON.stringify(cache));

  const gates = [2, 3];
  const equal = [0.2, 0.3, 0.4, 0.5, 0.75, 1.0];
  const asym = [[0.5, 0.25], [1.0, 0.4], [0.4, 0.8], [0.3, 0.6]];
  const trails = [0.1, 0.15, 0.25, 0.5];
  const combos = [];
  for (const gate of gates) {
    for (const x of equal) combos.push([gate, x, x]);
    for (const [a, b] of asym) combos.push([gate, a, b]);
  }
  const results = [];
  for (const [gate, TP, SL] of combos) {
    for (const TRAIL of trails) results.push(runCombo(syms, gate, TP, SL, TRAIL));
  }

  const byPnl = [...results].sort((a, b) => b.netPnl - a.netPnl);
  const byWr = [...results].sort((a, b) => b.wr - a.wr || b.netPnl - a.netPnl);
  const live = results.filter(r => r.liveCompatible);
  const liveProfitable = live.filter(r => r.netPnl > 0);
  const liveWr50 = live.filter(r => r.wr > 50);
  const anyProfitable = results.filter(r => r.netPnl > 0);
  const anyWr50 = results.filter(r => r.wr > 50);

  const out = {
    generatedAt: new Date().toISOString(),
    data: { range: { start: new Date(syms[0].k[0].t).toISOString(), end: new Date(syms[0].k[syms[0].k.length-1].t).toISOString(), bars: syms[0].k.length }, symbols: syms.map(s => s.sym) },
    feeModel: 'taker 0.04% round-trip; capital $20 risk $1 lev 5; notional=risk/(SL%)',
    caveat: 'Depth/orderbook trigger (live 4th signal) omitted — no historical L2. Entry=close at signal bar. Horizon=720 bars (12h).',
    totalCombos: results.length,
    top5ByNetPnl: byPnl.slice(0, 5),
    top5ByWR: byWr.slice(0, 5),
    verdict: {
      anyConfigProfitable: anyProfitable.length > 0,
      anyConfigWRgt50: anyWr50.length > 0,
      liveCompatibleProfitable: liveProfitable.length > 0,
      liveCompatibleWRgt50: liveWr50.length > 0,
      bestLiveConfig: byPnl.filter(r => r.liveCompatible)[0],
      bestOverallConfig: byPnl[0],
      bestWrConfig: byWr[0],
    },
    allResults: results,
  };
  fs.writeFileSync('/home/dwizzy/dwizzyOS/gauss/kalai/wr_study_sweep.json', JSON.stringify(out, null, 2));

  console.log('\n=== TOP 5 BY NET PnL ===');
  for (const r of byPnl.slice(0, 5)) console.log(`gate=${r.gate} TP=${r.tp} SL=${r.sl} trail=${r.trail} | WR=${r.wr}% N=${r.trades} PnL=$${r.netPnl}`);
  console.log('\n=== TOP 5 BY WR ===');
  for (const r of byWr.slice(0, 5)) console.log(`gate=${r.gate} TP=${r.tp} SL=${r.sl} trail=${r.trail} | WR=${r.wr}% N=${r.trades} PnL=$${r.netPnl}`);
  console.log('\nVERDICT: anyProfitable=', anyProfitable.length, 'anyWR>50=', anyWr50.length, 'liveProfitable=', liveProfitable.length, 'liveWR>50=', liveWr50.length);
  console.log('Best live config:', JSON.stringify(byPnl.filter(r => r.liveCompatible)[0]));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
