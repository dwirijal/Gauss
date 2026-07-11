// ── 3-Mode config ──────────────────────────────────────────────────────────
const MODE = process.env.KALAI_MODE || 'scalping';  // scalping | intraday | swing
const MODE_CFG = {
  scalping: { interval:'1m', lev:20, tp:0.4, sl:0.4, emaF:10, emaS:30 },
  intraday: { interval:'1h',   lev:20, tp:1.0, sl:1.0, emaF:20, emaS:50 },
  swing:    { interval:'4h',   lev:10, tp:1.5, sl:1.5, emaF:20, emaS:50 },
};
const MC = MODE_CFG[MODE] || MODE_CFG.scalping;
/**
 * KalAI — Technical Analysis + AI Trading Bot
 * Binance Futures Testnet (Demo2)
 *
 * Flow:
 *   Binance WS klines (1m) → TA Engine → AI Scoring → Execute
 */

'use strict';

const WebSocket = require('ws');
const Strategy = require('./strategy.js');
const axios     = require('axios');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');
const {
  RSI, EMA, MACD, BollingerBands, Stochastic, StochasticRSI
} = require('technicalindicators');

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY  = process.env.BINANCE_DEMO2_API_KEY || '';
const SECRET   = process.env.BINANCE_DEMO2_SECRET  || '';
const BASE_URL = 'https://testnet.binancefuture.com';
const WS_BASE  = 'wss://stream.binancefuture.com/stream';

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const AI_MODEL       = process.env.KALAI_MODEL || 'google/gemini-flash-1.5';

const SYMBOLS   = (process.env.KALAI_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const LEVERAGE  = parseInt(process.env.KALAI_LEVERAGE   || String(MC.lev));
const ORDER_USDT    = parseFloat(process.env.KALAI_ORDER_USDT || '20');
const TRADE_CAPITAL = parseFloat(process.env.KALAI_CAPITAL   || '20'); // only $20 active capital

// ── Mode params (from MODE_CFG) ─────────────────────────────────────────────
const EMA_FAST = MC.emaF, EMA_SLOW = MC.emaS;
const TP_PCT = parseFloat(process.env.KALAI_TP_PCT || String(MC.tp));   // asymmetric exit override
const SL_PCT = parseFloat(process.env.KALAI_SL_PCT || String(MC.sl));
const STRATEGY = process.env.KALAI_STRATEGY || 'counter';  // 'counter' | 'hft'
// ponytail: hft = HTF-bias mean-reversion (validated 60% WR / +$975 on 90d, research3/SIGNAL_REDESIGN_STUDY4.md)
const HTF_SLOPE_TH = parseFloat(process.env.KALAI_HTF_SLOPE || '0.15');
const CONFLUENCE_MIN = parseInt(process.env.KALAI_CONFLUENCE || '1');
const PSEUDO_CAPITAL = null;  // scaled to real testnet equity (2% risk), no pseudo override
const RISK_PCT      = parseFloat(process.env.KALAI_RISK_PCT  || '2');  // % per trade
const MIN_RISK      = parseFloat(process.env.KALAI_MIN_RISK  || '1');  // min $1 per trade
const TRAIL_DIST    = parseFloat(process.env.KALAI_TRAIL_DIST || process.env.TRAIL_DIST || '0.15');  // trailing callback %
// Effective risk per trade: max(2% of capital, $1)
function calcRisk(capital) { return Math.max(capital * (RISK_PCT / 100), MIN_RISK); }
const LIVE      = process.env.KALAI_LIVE === '1';
const INTERVAL  = process.env.KALAI_INTERVAL || MC.interval;
const CANDLES_NEEDED = 100; // min candles before signal

const JOURNAL_FILE = path.join(__dirname, 'trade_journal.json');

// ── State ─────────────────────────────────────────────────────────────────────
// { BTCUSDT: { opens, highs, lows, closes, volumes, lastSignal } }
const candles = {};

for (const sym of SYMBOLS) {
  candles[sym] = { opens: [], highs: [], lows: [], closes: [], volumes: [], lastSignal: null, lastSignalTs: 0 };
}

// ── Binance REST ──────────────────────────────────────────────────────────────
function sign(params) {
  const ts = Date.now();
  params.timestamp = ts;
  params.recvWindow = 5000;  // allow ±5s clock skew
  const qs = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', SECRET).update(qs).digest('hex');
  return qs + '&signature=' + sig;
}

async function bfx(method, endpoint, params = {}) {
  const qs  = sign(params);
  const url = method === 'GET'
    ? `${BASE_URL}${endpoint}?${qs}`
    : `${BASE_URL}${endpoint}`;
  const res = await axios({
    method, url,
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    data: method === 'POST' ? qs : undefined,   // POST: form body (Binance futures standard)
  });
  return res.data;
}

async function setLeverage(symbol) {
  try { await bfx('POST', '/fapi/v1/leverage', { symbol, leverage: LEVERAGE }); }
  catch (e) { /* already set */ }
}

async function placeOrder(symbol, side, usdt) {
  // Get latest price
  const ticker = await axios.get(`${BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
  const px     = parseFloat(ticker.data.price);

  // Precision map
  const PREC = { BTCUSDT:[3,0.001], ETHUSDT:[3,0.001], SOLUSDT:[1,0.1], BNBUSDT:[2,0.01] };
  const [dec, minQty] = PREC[symbol] || [2, 0.01];
  const qty = Math.max(parseFloat((usdt / px).toFixed(dec)), minQty);

  return bfx('POST', '/fapi/v1/order', {
    symbol,
    side: side === 'long' ? 'BUY' : 'SELL',
    type: 'MARKET',
    quantity: qty,
  });
}

// ── TA Engine (live) — must match backtester indicators ────────────────────────
function computeTA(sym) {
  const c = candles[sym];
  if (c.closes.length < CANDLES_NEEDED) return null;

  const closes = c.closes, highs = c.highs, lows = c.lows, volumes = c.volumes, n = closes.length;

  const rsiArr = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiArr[rsiArr.length - 1];

  const stoch = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
  const lastStoch = stoch[stoch.length - 1];

  const ema20 = EMA.calculate({ values: closes, period: 20 });
  const ema50 = EMA.calculate({ values: closes, period: 50 });
  const ema200 = EMA.calculate({ values: closes, period: 200 });

  const e20v = ema20[ema20.length - 1];
  const e20prev = ema20[ema20.length - 2] || e20v;

  return {
    price: closes[n - 1],
    rsi, stochK: lastStoch.k, stochD: lastStoch.d,
    ema20: e20v, ema50: ema50[ema50.length - 1], ema200: ema200[ema200.length - 1],
    ema20Slope: e20v - e20prev,
    volumes,
  };
}

// ── Fibonacci helper (live) ───────────────────────────────────────────────────
function fibLevels(high, low) {
  const range = high - low;
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0].reduce((acc, f) => { acc[f] = high - range * f; return acc; }, {});
}
function swingHighLow(candles, lookback) {
  const slice = candles.slice(-lookback);
  return { high: Math.max(...slice.map(c => c.high)), low: Math.min(...slice.map(c => c.low)) };
}
function nearFib(price, fibs, tol = 0.003) {
  for (const [lvl, fp] of Object.entries(fibs)) {
    if (Math.abs(price - fp) / fp < tol) return parseFloat(lvl);
  }
  return null;
}

// ── Volume (live) ─────────────────────────────────────────────────────────────
function volumeSignalLive(c) {
  const period = 20;
  const slice = c.volumes.slice(-period);
  const avgVol = slice.reduce((a, b) => a + b, 0) / slice.length;
  const cur = c.volumes[c.volumes.length - 1];
  return { spike: cur / avgVol, buyRatio: 0.5 };
}

// ── Pattern (live) ────────────────────────────────────────────────────────────
function detectPatternLive(c) {
  const n = c.closes.length;
  if (n < 3) return null;
  const cc = c.closes[n-1], co = c.opens[n-1], ch = c.highs[n-1], cl = c.lows[n-1];
  const pc = c.closes[n-2], po = c.opens[n-2];
  const body = Math.abs(cc - co), range = ch - cl;
  const bodyRatio = range > 0 ? body / range : 0;
  const lowerWick = Math.min(co, cc) - cl, upperWick = ch - Math.max(co, cc);
  if (bodyRatio < 0.1) return { name: 'doji', bias: 'neutral' };
  if (lowerWick > body * 2 && upperWick < body * 0.5 && cc > co) return { name: 'hammer', bias: 'bull' };
  if (upperWick > body * 2 && lowerWick < body * 0.5 && cc < co) return { name: 'shooting_star', bias: 'bear' };
  if (po < pc && cc > co && co < pc && cc > po) return { name: 'bullish_engulfing', bias: 'bull' };
  if (po > pc && cc < co && co > pc && cc < po) return { name: 'bearish_engulfing', bias: 'bear' };
  return null;
}

// ── Regime classifier (EMA50 slope + ATR%) ───────────────────────────────
function classifyRegime(sym) {
  const c = candles[sym]; const n = c.closes.length;
  if (n < 70) return 'CHOPPY';
  const e50 = EMA.calculate({ values: c.closes, period: 50 });
  const slope = (e50[n-1] - e50[n-21]) / e50[n-21] * 100;
  let atr = 0; for (let i = n-20; i < n; i++) atr += Math.max(c.highs[i]-c.lows[i], Math.abs(c.highs[i]-c.closes[i-1]), Math.abs(c.lows[i]-c.closes[i-1]));
  atr /= 20; const vol = atr / c.closes[n-1] * 100;
  if (vol > 0.8) return 'CHOPPY';
  if (slope > 0.3) return 'BULL';
  if (slope < -0.3) return 'BEAR';
  return 'CHOPPY';
}

// ── Signal Engine (live) — matches backtester ─────────────────────────────────
async function ruleBasedSignal(symbol) {
  if (STRATEGY === 'hft') return hftSignal(symbol);
  const c = candles[symbol];
  if (!c || c.closes.length < 50) return { signal: 'SKIP', confidence: 0, reason: 'insufficient_data' };
  const regime = classifyRegime(symbol);
  if (candles[symbol]) candles[symbol].regime = regime;
  const res = await Strategy.analyze(symbol, { closes: c.closes, highs: c.highs, lows: c.lows, volumes: c.volumes }, regime);
  const signal = res.side || 'SKIP';
  const confidence = Math.min(95, 55 + Math.abs(res.score) * 12);
  // save depth snapshot to DB for hermes learning
  if (res.depth) {
    try {
      const { Client, PG_DSN } = require('./db');
      const pg = new Client({ connectionString: PG_DSN });
      pg.connect().then(() => pg.query(
        'INSERT INTO depth_snapshots(symbol,bid_vol,ask_vol,imbalance,top_bid,top_ask) VALUES($1,$2,$3,$4,$5,$6)',
        [symbol, res.depth.bidVol, res.depth.askVol, res.depth.imbalance, res.depth.topBid, res.depth.topAsk]
      )).then(() => pg.end()).catch(() => {});
    } catch {}
  }
  return { signal, confidence, reason: res.reasons };
}
async function aiScore(symbol) { return ruleBasedSignal(symbol); }

// ── HTF-bias mean-reversion (validated 60% WR / +$975 on 90d; research3/SIGNAL_REDESIGN_STUDY4.md) ──
// ponytail: downsamples the live 1m buffer to 1h (bias) + approximates 5m entries via 1m eval.
// Faithful to proto_d90.js logic: 1h EMA50 slope gate + StochRSI cross/fib/barPos confluence.
function emaSlope1h(closes1m) {
  // downsample 1m -> 1h (60 bars), need >=72 1h bars for EMA50 + lookback
  const need = 72 * 60;
  if (closes1m.length < need) return null;
  const h = [];
  for (let i = 0; i + 60 <= closes1m.length; i += 60) h.push(closes1m[i + 59]);
  const e = EMA.calculate({ values: h, period: 50 });
  const slope = (e[e.length - 1] - e[e.length - 21]) / e[e.length - 21] * 100;
  return slope;
}
function hftSignal(symbol) {
  const c = candles[symbol];
  if (!c || c.closes.length < 72 * 60) return { signal: 'SKIP', confidence: 0, reason: 'warming_1h' };
  const slope = emaSlope1h(c.closes);
  if (slope === null) return { signal: 'SKIP', confidence: 0, reason: 'warming_1h' };
  const bias = slope > HTF_SLOPE_TH ? 'BULL' : (slope < -HTF_SLOPE_TH ? 'BEAR' : 'FLAT');
  if (bias === 'FLAT') return { signal: 'SKIP', confidence: 0, reason: `1h slope ${slope.toFixed(2)}% FLAT` };
  // 5m-ish StochRSI cross on trailing 1m closes
  const closes = c.closes, n = closes.length;
  const sr = Strategy.stochRSI(closes.slice(Math.max(0, n - 70)));
  const prev = Strategy.stochRSI(closes.slice(Math.max(0, n - 71), n - 1));
  const o = c.opens[n - 1], h = c.highs[n - 1], l = c.lows[n - 1], price = c.closes[n - 1];
  const barPos = h > l ? (price - l) / (h - l) : 0.5;
  let longHit = false, shortHit = false, reasons = [];
  if (sr && prev) {
    if (prev.k < 25 && prev.k <= prev.d && sr.k > sr.d) { longHit = true; reasons.push(`StochRSI cross-up(${sr.k}/${sr.d})`); }
    if (prev.k > 75 && prev.k >= prev.d && sr.k < sr.d) { shortHit = true; reasons.push(`StochRSI cross-dn(${sr.k}/${sr.d})`); }
  }
  // 1h swing fib-near
  const h1bars = [];
  for (let i = 0; i + 60 <= n; i += 60) h1bars.push({ h: Math.max(...c.highs.slice(i, i + 60)), l: Math.min(...c.lows.slice(i, i + 60)) });
  const swing = h1bars.slice(-20);
  const sH = Math.max(...swing.map(x => x.h)), sL = Math.min(...swing.map(x => x.l));
  const rng = sH - sL;
  if (rng > 0) [0.382, 0.5, 0.618].forEach(f => { if (Math.abs(price - (sL + rng * f)) / price < 0.0015) reasons.push('fib-near'); });
  const buyProxy = barPos > 0.5;
  const aligned = [longHit || shortHit, (rng > 0 && [0.382,0.5,0.618].some(f => Math.abs(price-(sL+rng*f))/price<0.0015)), bias==='BULL'?buyProxy:!buyProxy].filter(Boolean).length;
  if (aligned < CONFLUENCE_MIN) return { signal: 'SKIP', confidence: 0, reason: `confluence ${aligned}<${CONFLUENCE_MIN} | slope ${slope.toFixed(2)}%` };
  let signal = null;
  if (bias === 'BULL' && longHit && buyProxy) signal = 'LONG';
  else if (bias === 'BEAR' && shortHit && !buyProxy) signal = 'SHORT';
  if (!signal) return { signal: 'SKIP', confidence: 0, reason: `no dir-aligned entry | slope ${slope.toFixed(2)}%` };
  return { signal, confidence: 75, reason: reasons.join(' | ') + ` | 1h ${bias} ${slope.toFixed(2)}%` };
}

// ── Journal ───────────────────────────────────────────────────────────────────// ── Journal ───────────────────────────────────────────────────────────────────
function appendJournal(record) {
  let j = [];
  try { j = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); } catch {}
  j.push(record);
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2));
}

// ── Signal handler ────────────────────────────────────────────────────────────

async function handleSignal(symbol) {
  if (process.env.KALAI_DEBUG) console.error("[HS] handleSignal "+symbol);
  const c = candles[symbol];
  if (c.pending) return;          // sync guard: block concurrent tick re-entry
  c.pending = true;
  const now = Date.now();
  if (now - (c.lastSignalTs || 0) < SIGNAL_COOLDOWN) { c.pending = false; return; }
  if (openPositions[symbol] || activePositions[symbol]) { c.pending = false; return; }
  if (pausedUntil[symbol] && now < pausedUntil[symbol]) return;

  if (process.env.KALAI_FORCE === '1') { var result = { signal: symbol==='BTCUSDT'?'LONG':(symbol==='ETHUSDT'?'LONG':'LONG'), confidence: 90, reason: 'FORCED_TEST' }; }
  else { var result = await aiScore(symbol); }
  const { signal, confidence, reason } = result;
  const regime = classifyRegime(symbol);
  if (candles[symbol]) candles[symbol].regime = regime;
  console.log(`[SIGNAL] ${symbol} [${regime}] → ${signal} (${confidence}%) | ${reason}`);

  if (signal === 'SKIP' || confidence < 60) return;

  c.lastSignal = signal;
  c.lastSignalTs = now;
  openPositions[symbol] = true;
  c.pending = false;

  const price = c.closes[c.closes.length - 1];
  const record = { ts: new Date().toISOString(), symbol, signal, confidence, reason, price, mode: LIVE ? 'live' : 'paper' };

  if (!LIVE) {
    console.log(`[PAPER] ${signal} ${symbol} @ ${price}`);
    appendJournal(record);
    setTimeout(() => { openPositions[symbol] = false; }, SIGNAL_COOLDOWN);
    return;
  }

  try {
    await setLeverage(symbol);
    // Use live ticker price for entry (candle close is stale up to interval)
    const livePx = parseFloat((await bfx('GET', '/fapi/v1/ticker/price', { symbol })).price);
    const equity = await fetchEquity();  // 2% risk of REAL testnet balance ($5000 -> $100/trade)
    const riskAmt = Math.max(equity * (RISK_PCT / 100), MIN_RISK);
    const notional = riskAmt / (SL_PCT / 100);  // notional = risk / SL% (lev only affects margin)
    const qty = await sizePosition(symbol, notional, livePx);
    const side = signal === 'LONG' ? 'BUY' : 'SELL';
    // Entry: MARKET (guaranteed fill on breakout). Testnet accepts MARKET for entry; only conditional TP/SL/TRAILING are restricted.
    const order = await bfx('POST', '/fapi/v1/order', { symbol, side, type:'MARKET', quantity:qty, newOrderRespType:'RESULT' });
    record.order_id = order.orderId;
    record.order_qty = order.origQty;
    const fillPx = parseFloat(order.avgPrice) || livePx;
    const tpPrice = signal === 'LONG' ? fillPx * (1 + TP_PCT/100) : fillPx * (1 - TP_PCT/100);
    const slPrice = signal === 'LONG' ? fillPx * (1 - SL_PCT/100) : fillPx * (1 + SL_PCT/100);
    const closeSide = signal === 'LONG' ? 'SELL' : 'BUY';
        // Bot-managed TP/SL + trailing (testnet rejects exchange conditional orders with -4120)
    const pos = { symbol, side: signal, qty, entry: fillPx, tp: tpPrice, sl: slPrice, trailed: false, closeSide, ts: Date.now() };
    activePositions[symbol] = pos;
    writePositions();
    startMonitor();
    const pr = await bfx('GET','/fapi/v2/positionRisk',{symbol}).catch(()=>null);
    const act = pr && pr.find(p=>p.symbol===symbol);
    const actAmt = act ? Math.abs(parseFloat(act.positionAmt)) : 0;
    console.log(`[EXEC] ✅ ${signal} ${symbol} qty=${qty} @${fillPx.toFixed(2)} RR1:1 TP=${tpPrice.toFixed(2)} SL=${slPrice.toFixed(2)} trail=${TRAIL_DIST}% (bot-managed) | livePos=${actAmt}`);
    // safety: auto-close if not filled in 5min, release slot
    setTimeout(async () => {
      if (activePositions[symbol]) { console.log('[TIMEOUT] closing unfilled', symbol); await closePos(pos); }
      if (!activePositions[symbol]) openPositions[symbol] = false;
    }, 5 * 60 * 1000);
  } catch (e) {
    record.error = e.message;
    openPositions[symbol] = false;
    c.pending = false;
    console.error(`[EXEC] ❌ ${symbol} ${e.message?.slice(0, 120)}`);
  }
  appendJournal(record);
}


const SIGNAL_COOLDOWN = MODE === 'scalping' ? 30 * 1000 : 5 * 60 * 1000;
const openPositions = {};
const activePositions = {};
let monitorTimer = null;

function writePositions() {
  try {
    fs.writeFileSync(path.join(__dirname, 'kalai_positions.json'), JSON.stringify(activePositions, null, 2));
  } catch (e) {
    console.error('[WRITE_POSITIONS_ERR]', e.message);
  }
}

async function closePos(p) {
  try { await bfx('POST', '/fapi/v1/order', { symbol: p.symbol, side: p.closeSide, type:'MARKET', quantity: p.qty, reduceOnly:true }); }
  catch (e) { console.error('[CLOSE] ❌', p.symbol, e.message?.slice(0,80)); }
  delete activePositions[p.symbol];
  writePositions();
  openPositions[p.symbol] = false;
}

function startMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(async () => {
    try {
      for (const sym of Object.keys(activePositions)) {
        const p = activePositions[sym];
        const tk = await bfx('GET', '/fapi/v1/ticker/price', { symbol: sym });
        const px = parseFloat(tk.price);
        const isL = p.side === 'LONG';
        
        // Track best price achieved
        if (!p.bestPx) p.bestPx = p.entry;
        p.bestPx = isL ? Math.max(p.bestPx, px) : Math.min(p.bestPx, px);

        const move = isL ? (px - p.entry)/p.entry*100 : (p.entry - px)/p.entry*100;
        const targetTpPct = TP_PCT; // e.g. 0.4%

        // 1. Break-Even Guard: Lock SL at entry + fee offset (0.08% roundtrip) if profit reached 50% of TP target
        if (move >= (targetTpPct * 0.5)) {
          const bePx = isL ? p.entry * 1.0008 : p.entry * 0.9992;
          if (isL ? p.sl < bePx : p.sl > bePx) {
            p.sl = bePx;
            console.log(`[BREAK-EVEN LOCK] locked SL for ${sym} at ${bePx.toFixed(4)}`);
          }
        }

        // 2. Trailing Stop: trailing locks from the highest/lowest price achieved
        if (!p.trailed && move >= TRAIL_DIST) p.trailed = true;
        if (p.trailed) {
          const trailPx = isL ? p.bestPx * (1 - TRAIL_DIST/100) : p.bestPx * (1 + TRAIL_DIST/100);
          if (isL) {
            if (trailPx > p.sl) p.sl = trailPx;
          } else {
            if (trailPx < p.sl) p.sl = trailPx;
          }
        }

        // 3. Execution triggers
        if (isL ? px >= p.tp : px <= p.tp) { console.log('[TP] ✅', sym, px.toFixed(2)); await closePos(p); }
        else if (isL ? px <= p.sl : px >= p.sl) { console.log('[SL/TRAILING] ❌', sym, px.toFixed(2)); await closePos(p); }
      }
    } catch (e) { /* transient network */ }
  }, 2000);
}
const lossStreak = {};  // symbol -> consecutive losses
const pausedUntil = {}; // symbol -> timestamp

async function fetchEquity() {
  try {
    const d = await bfx('GET', '/fapi/v2/account', {});
    return parseFloat(d.totalMarginBalance) || TRADE_CAPITAL;
  } catch { return TRADE_CAPITAL; }
}

async function sizePosition(symbol, notional, price) {
  const PREC = { BTCUSDT:[3,0.001], ETHUSDT:[3,0.001], SOLUSDT:[1,0.1], BNBUSDT:[2,0.01] };
  const [dec, minQty] = PREC[symbol] || [2, 0.01];
  return Math.max(parseFloat((notional / price).toFixed(dec)), minQty);
}

async function placeOrderRaw(symbol, side, qty, price) {
  // Maker limit (postOnly) to cut fee 0.04% → 0.02%
  return bfx('POST', '/fapi/v1/order', {
    symbol, side, type: 'LIMIT', timeInForce: 'GTX', quantity: qty,
    price: +price.toFixed(price < 1 ? 4 : 2), reduceOnly: false,
    newOrderRespType: 'RESULT',
  });
}


// ── Seed historical candles via REST ─────────────────────────────────────────
async function seedCandles(symbol) {
  const need = STRATEGY === 'hft' ? 4500 : CANDLES_NEEDED;  // hft needs ~72*60 1m bars for 1h downsample
  console.log(`[SEED] Fetching ${need} candles for ${symbol}...`);
  let collected = [];
  let endTime = Date.now();
  while (collected.length < need) {
    const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, {
      params: { symbol, interval: INTERVAL, limit: 1500, endTime }
    });
    if (!res.data.length) break;
    collected = res.data.concat(collected);  // earliest first
    endTime = res.data[0][0] - 1;
    if (res.data.length < 1500) break;
  }
  collected = collected.slice(-need);
  for (const k of collected) {
    const c = candles[symbol];
    c.opens.push(parseFloat(k[1]));
    c.highs.push(parseFloat(k[2]));
    c.lows.push(parseFloat(k[3]));
    c.closes.push(parseFloat(k[4]));
    c.volumes.push(parseFloat(k[5]));
  }
  console.log(`[SEED] ${symbol} ready — ${candles[symbol].closes.length} candles`);
}

// ── WebSocket klines ──────────────────────────────────────────────────────────
function connectWS() {
  const streams = SYMBOLS.map(s => `${s.toLowerCase()}@kline_${INTERVAL}`).join('/');
  const url     = `${WS_BASE}?streams=${streams}`;

  console.log(`[WS] Connecting to ${url}`);
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('[WS] ✅ connected');
    if (process.env.KALAI_FORCE === '1') {
      console.log('[FORCE] firing signals immediately');
      SYMBOLS.forEach((s, i) => setTimeout(() => handleSignal(s).catch(e => console.error('[FORCE ERR]', e.message)), 1500 + i * 800));
    }
  });

  ws.on('error', e => console.error('[WS ERR]', e.message));
  ws.on('close', (code) => console.error('[WS CLOSE] code='+code));

  ws.on('message', async (raw) => {
    if (process.env.KALAI_DEBUG) console.error('[RAW MSG] len='+raw.length);
    try {
      const msg  = JSON.parse(raw);
      const data = msg.data || msg;
      const k    = data.k;
      const symbol = k.s;
      const closed = k.x; // true = candle closed
      if (process.env.KALAI_DEBUG) console.error('[WS MSG] '+symbol+' closed='+k.x);
      if (!k) return;

      const c = candles[symbol];
      if (!c) return;

      const ko = parseFloat(k.o), kh = parseFloat(k.h), kl = parseFloat(k.l), kc = parseFloat(k.c);
      if (closed) {
        c.opens.push(ko); c.highs.push(kh); c.lows.push(kl); c.closes.push(kc); c.volumes.push(parseFloat(k.v));
        if (c.closes.length > 500) {
          c.opens.shift(); c.highs.shift(); c.lows.shift(); c.closes.shift(); c.volumes.shift();
        }
      } else {
        const n = c.closes.length - 1;
        if (n >= 0) {
          c.highs[n]  = Math.max(c.highs[n], kh);
          c.lows[n]   = Math.min(c.lows[n], kl);
          c.closes[n] = kc;
        }
      }

      const ta = computeTA(symbol);
      if (ta) await handleSignal(symbol, ta);

      // live state for dashboard SSE (throttled 1s)
      const now = Date.now();
      if (!global._lastStateWrite || now - global._lastStateWrite > 1000) {
        global._lastStateWrite = now;
        const st = {};
        for (const s of SYMBOLS) {
          const cc = candles[s];
          if (cc && cc.closes.length) { try { cc.regime = classifyRegime(s); } catch {} st[s] = { price: cc.closes[cc.closes.length-1], regime: cc.regime || '?', at: now }; }
        }
        try { require('fs').writeFileSync(__dirname + '/state.json', JSON.stringify(st)); } catch {}
      }
    } catch (e) {
      console.error('[WS MSG ERR]', e.message);
    }
  });

  ws.on('close', () => {
    console.warn('[WS] Disconnected, reconnecting in 5s...');
    setTimeout(connectWS, 5000);
  });

  ws.on('error', (e) => console.error('[WS ERR]', e.message));
}


// Recover open positions from exchange after restart (bot-managed SL/TP)
async function recoverPositions() {
  try {
    const pr = await bfx('GET', '/fapi/v2/positionRisk');
    const open = pr.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
    for (const p of open) {
      const sym = p.symbol;
      const amt = parseFloat(p.positionAmt);
      const entry = parseFloat(p.entryPrice);
      const side = amt > 0 ? 'LONG' : 'SHORT';
      const closeSide = amt > 0 ? 'SELL' : 'BUY';
      const tp = side === 'LONG' ? entry * (1 + TP_PCT/100) : entry * (1 - TP_PCT/100);
      const sl = side === 'LONG' ? entry * (1 - SL_PCT/100) : entry * (1 + SL_PCT/100);
      activePositions[sym] = { symbol: sym, side, qty: Math.abs(amt), entry, tp, sl, trailed: false, closeSide, ts: Date.now() };
      console.log(`[RECOVER] ${sym} ${side} qty=${Math.abs(amt)} @${entry} SL=${sl.toFixed(2)} TP=${tp.toFixed(2)}`);
    }
    writePositions();
    if (open.length) startMonitor();
  } catch (e) { console.error('[RECOVER ERR]', e.message); }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[KALAI] mode=${MODE} | LIVE=${LIVE} | symbols=${SYMBOLS.join(',')} | interval=${INTERVAL}`);
  console.log(`[KALAI] AI model: ${OPENROUTER_KEY ? AI_MODEL : 'rule-based (no OPENROUTER_API_KEY)'}`);

  // Seed historical candles for all symbols
  if (LIVE) { try { const eq = await fetchEquity(); console.log('[EQUITY] testnet balance =', eq); } catch(e){ console.log('[EQUITY] FAIL', e.message?.slice(0,80)); } }
  await Promise.all(SYMBOLS.map(seedCandles));

  // Connect WS
  recoverPositions();
  connectWS();
}


async function closeAll() {
  try {
    const pr = await bfx('GET', '/fapi/v2/positionRisk', {});
    const open = pr.filter(p => Math.abs(parseFloat(p.positionAmt)) > 0);
    for (const p of open) {
      const side = parseFloat(p.positionAmt) > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(parseFloat(p.positionAmt));
      const r = await bfx('POST', '/fapi/v1/order', { symbol: p.symbol, side, type: 'MARKET', quantity: qty, reduceOnly: true });
      console.log(`CLOSEALL ${p.symbol} ${qty} -> OK ${r.orderId}`);
    }
    if (!open.length) console.log('CLOSEALL no position');
  } catch (e) { console.log('CLOSEALL ERR', e.message?.slice(0, 120)); }
}


// ── Self-test: place 1 tiny order + bracket + trailing, then cleanup (uses bfx) ──
if (process.env.KALAI_SELFTEST === '1') selfTest();
else if (process.env.KALAI_CLOSEALL === '1') closeAll();
else { main().catch(e => { console.error(e); process.exit(1); }); }
