/**
 * KalAI Backtester v3 — Multiframe (HTF bias + LTF entry)
 * HTF: 4h/1h for trend & key levels
 * LTF: 5m for precise entry (mean reversion at fib + volume)
 * Target: 80%+ winrate, tight SL
 */

'use strict';

const axios = require('axios');
const ccxt  = require('ccxt');
const { RSI, StochasticRSI, EMA } = require('technicalindicators');

const SYMBOL       = process.env.BT_SYMBOL   || 'BTCUSDT';
const HTF          = process.env.BT_HTF      || '1h';    // higher timeframe
const LTF          = process.env.BT_LTF      || '5m';    // lower timeframe
const LIMIT        = parseInt(process.env.BT_LIMIT || '1500');
const CAPITAL      = parseFloat(process.env.BT_CAPITAL || '20');
const RISK_PCT     = parseFloat(process.env.BT_RISK    || '2');
const MIN_RISK     = parseFloat(process.env.BT_MIN_RISK || '1');
const LEVERAGE     = parseFloat(process.env.BT_LEV     || '5');
const SL_PCT       = parseFloat(process.env.BT_SL      || '0.5'); // tight SL on 5m
const TP_PCT       = parseFloat(process.env.BT_TP      || '1.0'); // 2:1
const FIB_LOOKBACK = parseInt(process.env.BT_FIB_LB    || '100');
const MAKER_FEE    = parseFloat(process.env.BT_MAKER_FEE || '0.0002');
const TAKER_FEE    = parseFloat(process.env.BT_TAKER_FEE || '0.0004');
const USE_CCXT     = process.env.BT_CCXT === '1';

const BASE_URL = 'https://fapi.binance.com';

async function fetchKlines(symbol, interval, limit) {
  if (USE_CCXT) {
    const ex = new ccxt.binance();
    const bars = await ex.fetchOHLCV(symbol.replace('USDT', '/USDT'), interval, undefined, limit);
    return bars.map(k => ({
      ts: k[0], open: k[1], high: k[2], low: k[3], close: k[4],
      volume: k[5], buyVol: k[5] * (k[4] > k[1] ? 0.6 : 0.4), totalVol: k[5],
    }));
  }
  const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, { params: { symbol, interval, limit } });
  return res.data.map(k => ({
    ts: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]),
    close: parseFloat(k[4]), volume: parseFloat(k[5]), buyVol: parseFloat(k[9]), totalVol: parseFloat(k[5]),
  }));
}

function fibLevels(high, low) {
  const range = high - low;
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0].reduce((acc, f) => { acc[f] = high - range * f; return acc; }, {});
}
function swingHighLow(candles, lookback) {
  const slice = candles.slice(-lookback);
  return { high: Math.max(...slice.map(c => c.high)), low: Math.min(...slice.map(c => c.low)) };
}
function nearFib(price, fibs, tol = 0.005) {
  for (const [level, fibPrice] of Object.entries(fibs)) {
    if (Math.abs(price - fibPrice) / fibPrice < tol) return parseFloat(level);
  }
  return null;
}
function volumeSignal(candles, i, period = 20) {
  const slice = candles.slice(Math.max(0, i - period), i);
  const avgVol = slice.reduce((a, c) => a + c.volume, 0) / slice.length;
  const cur = candles[i];
  return { spike: cur.volume / avgVol, buyRatio: cur.buyVol / (cur.totalVol || 1), avgVol };
}

// ── HTF Analysis — trend bias + key levels ────────────────────────────────────
function analyzeHTF(candles) {
  const closes = candles.map(c => c.close);
  const rsiArr = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiArr[rsiArr.length - 1];

  const ema50  = EMA.calculate({ values: closes, period: 50 });
  const ema200 = EMA.calculate({ values: closes, period: 200 });
  const e50 = ema50[ema50.length - 1], e200 = ema200[ema200.length - 1];

  const { high, low } = swingHighLow(candles, FIB_LOOKBACK);
  const fibs = fibLevels(high, low);

  // Trend bias
  let bias = 'NEUTRAL';
  if (closes[closes.length - 1] > e200 && e50 > e200) bias = 'BULL';
  else if (closes[closes.length - 1] < e200 && e50 < e200) bias = 'BEAR';

  return { rsi, bias, fibs, swingHigh: high, swingLow: low };
}

// ── LTF Signal — entry at fib + volume + momentum ────────────────────────────
function generateLTFSignal(ltfCandles, i, htf) {
  const c = ltfCandles[i], p = ltfCandles[i - 1];
  if (!p) return { signal: 'SKIP', reason: 'no_prev' };

  const price = c.close;
  const vol = volumeSignal(ltfCandles, i);
  if (vol.spike < 1.5) return { signal: 'SKIP', reason: 'low_volume' };

  // LTF indicators
  const closes = ltfCandles.slice(0, i + 1).map(x => x.close);
  const rsiArr = RSI.calculate({ values: closes, period: 14 });
  const rsi = rsiArr[rsiArr.length - 1];

  const stoch = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
  const lastStoch = stoch[stoch.length - 1];
  const stochK = lastStoch.k, stochD = lastStoch.d;

  // Find nearest fib level from HTF
  const nearLevel = nearFib(price, htf.fibs);

  // LONG: HTF bullish + price at/below support + LTF oversold + volume
  if (htf.bias === 'BULL' && nearLevel !== null && [0, 0.236, 0.382, 0.5, 0.618].includes(nearLevel)) {
    if (rsi < 40 && stochK < 30 && vol.buyRatio > 0.5) {
      return { signal: 'LONG', confidence: 88, reason: `htf_bull_fib${nearLevel}_ltf_oversold`, rsi: rsi.toFixed(1), fib: nearLevel };
    }
  }

  // SHORT: HTF bearish + price at/above resistance + LTF overbought + volume
  if (htf.bias === 'BEAR' && nearLevel !== null && [1.0, 0.786, 0.618, 0.5].includes(nearLevel)) {
    if (rsi > 60 && stochK > 70 && vol.buyRatio < 0.5) {
      return { signal: 'SHORT', confidence: 88, reason: `htf_bear_fib${nearLevel}_ltf_overbought`, rsi: rsi.toFixed(1), fib: nearLevel };
    }
  }

  return { signal: 'SKIP', reason: 'no_setup', rsi: rsi.toFixed(1), fib: nearLevel };
}

// ── Backtest (LTF driven, HTF filtered) ───────────────────────────────────────
async function runBacktest() {
  console.log(`[BT] Fetching HTF ${HTF} and LTF ${LTF} for ${SYMBOL}...`);
  const htfCandles = await fetchKlines(SYMBOL, HTF, Math.min(LIMIT, 500));
  const ltfCandles = await fetchKlines(SYMBOL, LTF, LIMIT);

  const htf = analyzeHTF(htfCandles);
  console.log(`[BT] HTF bias: ${htf.bias} | RSI: ${htf.rsi?.toFixed(1)} | Swing: ${htf.swingLow.toFixed(2)}-${htf.swingHigh.toFixed(2)}`);

  let capital = CAPITAL;
  let position = null;
  const trades = [];
  const START = 50;

  for (let i = START; i < ltfCandles.length; i++) {
    const price = ltfCandles[i].close, high = ltfCandles[i].high, low = ltfCandles[i].low;

    if (position) {
      let closed = false, exitPrice = null, exitReason = null;
      if (position.side === 'LONG') {
        if (low  <= position.sl) { exitPrice = position.sl; exitReason = 'sl'; closed = true; }
        if (high >= position.tp) { exitPrice = position.tp; exitReason = 'tp'; closed = true; }
      } else {
        if (high >= position.sl) { exitPrice = position.sl; exitReason = 'sl'; closed = true; }
        if (low  <= position.tp) { exitPrice = position.tp; exitReason = 'tp'; closed = true; }
      }
      if (closed) {
        const pnlPct = position.side === 'LONG' ? (exitPrice - position.entry) / position.entry : (position.entry - exitPrice) / position.entry;
        const notional = position.qty * LEVERAGE;
        const fee = notional * TAKER_FEE * 2;
        const pnl = position.qty * pnlPct * LEVERAGE - fee;
        capital += pnl;
        trades.push({ ts: new Date(ltfCandles[i].ts).toISOString(), side: position.side, entry: position.entry, exit: exitPrice, reason: exitReason, pnl: pnl.toFixed(4), capital: capital.toFixed(2), pnlPct: (pnlPct * LEVERAGE * 100).toFixed(2) + '%' });
        position = null;
      }
    }

    if (!position) {
      const sig = generateLTFSignal(ltfCandles, i, htf);
      if (sig.signal !== 'SKIP') {
        const riskAmt = Math.max(capital * (RISK_PCT / 100), MIN_RISK);
        const qty = riskAmt;
        const sl = sig.signal === 'LONG' ? price * (1 - SL_PCT / 100) : price * (1 + SL_PCT / 100);
        const tp = sig.signal === 'LONG' ? price * (1 + TP_PCT / 100) : price * (1 - TP_PCT / 100);
        position = { side: sig.signal, entry: price, qty, sl, tp };
      }
    }
  }
  return { trades, finalCapital: capital };
}

function printStats(trades, finalCapital) {
  const wins  = trades.filter(t => parseFloat(t.pnl) > 0);
  const loses = trades.filter(t => parseFloat(t.pnl) <= 0);
  const totalPnl = trades.reduce((a, t) => a + parseFloat(t.pnl), 0);
  const tpHits = trades.filter(t => t.reason === 'tp').length;
  const slHits = trades.filter(t => t.reason === 'sl').length;

  let peak = CAPITAL, maxDD = 0, runCap = CAPITAL;
  for (const t of trades) {
    runCap = parseFloat(t.capital);
    if (runCap > peak) peak = runCap;
    const dd = (peak - runCap) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  const grossWin  = wins.reduce((a, t) => a + parseFloat(t.pnl), 0);
  const grossLoss = Math.abs(loses.reduce((a, t) => a + parseFloat(t.pnl), 0));
  const pf = grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : '∞';
  const avgWin  = wins.length  ? grossWin  / wins.length  : 0;
  const avgLoss = loses.length ? grossLoss / loses.length : 0;
  const rr = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞';

  console.log('\n════════════════════════════════════════');
  console.log(`  KalAI v3 Multiframe — ${SYMBOL} HTF:${HTF} LTF:${LTF} x${LIMIT}`);
  console.log('════════════════════════════════════════');
  console.log(`  Capital:       $${CAPITAL.toFixed(0)} → $${finalCapital.toFixed(2)}`);
  console.log(`  Total PnL:     $${totalPnl.toFixed(2)} (${((totalPnl/CAPITAL)*100).toFixed(2)}%)`);
  console.log(`  Total Trades:  ${trades.length} (TP: ${tpHits} | SL: ${slHits})`);
  console.log(`  Win Rate:      ${trades.length ? ((wins.length/trades.length)*100).toFixed(1) : 0}% (${wins.length}W / ${loses.length}L)`);
  console.log(`  Profit Factor: ${pf}`);
  console.log(`  Avg R:R:       ${rr}`);
  console.log(`  Max Drawdown:  ${maxDD.toFixed(2)}%`);
  console.log(`  Fees:          Taker ${(TAKER_FEE*100).toFixed(2)}%`);
  console.log(`  Leverage:      ${LEVERAGE}x | SL: ${SL_PCT}% | TP: ${TP_PCT}%`);
  console.log('════════════════════════════════════════');

  if (trades.length) {
    console.log('\n  Last 10 Trades:');
    for (const t of trades.slice(-10)) {
      const emoji = parseFloat(t.pnl) > 0 ? '✅' : '❌';
      console.log(`  ${emoji} ${t.ts.slice(0,16)} ${t.side.padEnd(5)} entry=${t.entry.toFixed(2)} exit=${t.exit.toFixed(2)} pnl=$${t.pnl} (${t.pnlPct}) [${t.reason.toUpperCase()}]`);
    }
  }
}

async function main() {
  const { trades, finalCapital } = await runBacktest();
  printStats(trades, finalCapital);
}

main().catch(e => { console.error(e.message); process.exit(1); });
