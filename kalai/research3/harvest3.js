// ponytail: CJS so it runs without type:module; axios (timeouts) so a hung fetch can't eat the run.
// Incremental per-symbol writes: a crash loses at most one symbol, not all.
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SYMS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const BASE = 'https://fapi.binance.com/fapi/v1/klines';
const OUT = __dirname + '/';
const LIMIT = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const to = Date.now();
const from = to - 90 * 24 * 3600 * 1000;

async function fetchPages(sym, interval) {
  const bars = [];
  let start = from;
  let guard = 0;
  while (start < to && guard < 40) {
    guard++;
    const { data } = await axios.get(BASE, {
      params: { symbol: sym, interval, limit: LIMIT, startTime: start },
      timeout: 20000,
    });
    if (!data.length) break;
    for (const r of data) bars.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    const last = data[data.length - 1][0];
    if (data.length < LIMIT) break; // reached current edge
    start = last + 1; // strict advance past last bar
    await sleep(250); // polite, not 1s — we have headroom
  }
  return bars;
}

function gaps(bars, ms) {
  let n = 0;
  for (let i = 1; i < bars.length; i++) if (bars[i].t - bars[i - 1].t !== ms) n++;
  return n;
}

(async () => {
  const perSymbol = {};
  let minFrom = to, maxTo = from;
  for (const sym of SYMS) {
    const m5 = await fetchPages(sym, '5m');
    const m1 = await fetchPages(sym, '1h');
    fs.writeFileSync(`${OUT}m5_${sym}.json`, JSON.stringify(m5));
    fs.writeFileSync(`${OUT}h1_${sym}.json`, JSON.stringify(m1));
    const g5 = gaps(m5, 5 * 60000), g1 = gaps(m1, 60 * 60000);
    if (m5.length) { minFrom = Math.min(minFrom, m5[0].t); maxTo = Math.max(maxTo, m5.at(-1).t); }
    perSymbol[sym] = { bars5m: m5.length, bars1h: m1.length, gaps5m: g5, gaps1h: g1 };
    console.log(`${sym}: 5m=${m5.length}(gaps ${g5}), 1h=${m1.length}(gaps ${g1})`);
  }
  const ds = {
    generated: new Date().toISOString(),
    range: { fromISO: new Date(minFrom).toISOString(), toISO: new Date(maxTo).toISOString() },
    perSymbol,
    files: SYMS.flatMap((s) => [`m5_${s}.json`, `h1_${s}.json`]),
  };
  fs.writeFileSync(`${OUT}dataset3.json`, JSON.stringify(ds, null, 2));
  console.log('\n=== harvest3 done ===', ds.range.fromISO, '->', ds.range.toISO);
})().catch((e) => { console.error('HARVEST FAIL:', e.message); process.exit(1); });
