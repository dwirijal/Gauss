const fs = require('fs');
const path = require('path');
const axios = require('axios');

const OUT = path.join(__dirname);
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
const INTERVAL = '1m';
const PAGE_LIMIT = 1500;
const MAX_PAGES = 6;
const BASE = 'https://fapi.binance.com/fapi/v1/klines';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toBar(k) {
  return { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] };
}

// group consecutive 1m bars into coarser TF by floor(t/step)
function aggregate(bars, stepMs) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.t / stepMs) * stepMs;
    if (!cur || cur.t !== bucket) {
      cur = { t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return out;
}

async function fetchSymbol(symbol) {
  const url = `${BASE}?symbol=${symbol}&interval=${INTERVAL}&limit=${PAGE_LIMIT}`;
  const first = await axios.get(`${url}&endTime=${Date.now()}`);
  if (!Array.isArray(first.data)) throw new Error(`${symbol} first page not array`);
  let bars = first.data.map(toBar);
  let lastClose = bars[bars.length - 1].t;
  const gaps = [];

  for (let p = 1; p < MAX_PAGES && bars.length < 7200; p++) {
    await sleep(1000);
    const r = await axios.get(`${url}&endTime=${bars[0].t - 1}`);
    if (!Array.isArray(r.data)) { console.log(`${symbol} page ${p} not array, skip`); break; }
    const page = r.data.map(toBar);
    if (page.length === 0) break;
    // contiguity check against current earliest
    const prevExpected = bars[0].t - PAGE_LIMIT * 60000;
    if (page[page.length - 1].t !== prevExpected) {
      gaps.push({ page: p, expectedBefore: prevExpected, got: page[page.length - 1].t });
    }
    bars = page.concat(bars);
    lastClose = bars[bars.length - 1].t;
  }

  bars.sort((a, b) => a.t - b.t);
  // contiguity check across full series
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].t - bars[i - 1].t !== 60000) {
      gaps.push({ idx: i, prev: bars[i - 1].t, cur: bars[i].t });
    }
  }

  if (gaps.length) console.log(`${symbol} gaps detected:`, JSON.stringify(gaps).slice(0, 300));

  fs.writeFileSync(path.join(OUT, `raw_${symbol}.json`), JSON.stringify(bars));
  const m5 = aggregate(bars, 5 * 60000);
  const m15 = aggregate(bars, 15 * 60000);
  const h1 = aggregate(bars, 60 * 60000);
  fs.writeFileSync(path.join(OUT, `m5_${symbol}.json`), JSON.stringify(m5));
  fs.writeFileSync(path.join(OUT, `m15_${symbol}.json`), JSON.stringify(m15));
  fs.writeFileSync(path.join(OUT, `h1_${symbol}.json`), JSON.stringify(h1));

  return { bars1m: bars.length, bars5m: m5.length, bars15m: m15.length, bars1h: h1.length, from: bars[0].t, to: bars[bars.length - 1].t };
}

(async () => {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  const perSymbol = {};
  let gFrom = Infinity, gTo = -Infinity;
  for (const s of SYMBOLS) {
    console.log(`harvesting ${s}...`);
    perSymbol[s] = await fetchSymbol(s);
    gFrom = Math.min(gFrom, perSymbol[s].from);
    gTo = Math.max(gTo, perSymbol[s].to);
  }
  const index = {
    generated: new Date().toISOString(),
    range: { from: gFrom, to: gTo, fromISO: new Date(gFrom).toISOString(), toISO: new Date(gTo).toISOString() },
    perSymbol,
    files: {
      raw: SYMBOLS.map((s) => `research/raw_${s}.json`),
      m5: SYMBOLS.map((s) => `research/m5_${s}.json`),
      m15: SYMBOLS.map((s) => `research/m15_${s}.json`),
      h1: SYMBOLS.map((s) => `research/h1_${s}.json`),
    },
  };
  fs.writeFileSync(path.join(OUT, 'dataset.json'), JSON.stringify(index, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log('range:', index.range.fromISO, '->', index.range.toISO);
  for (const s of SYMBOLS) {
    const c = perSymbol[s];
    console.log(`${s}: 1m=${c.bars1m} 5m=${c.bars5m} 15m=${c.bars15m} 1h=${c.bars1h}`);
  }
  console.log('index: research/dataset.json');
  console.log('files written: 12');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
