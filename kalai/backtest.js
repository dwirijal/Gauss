/**
 * KalAI Backtester — Pure Technical Analysis + Fee Model
 * Fibonacci, RSI, StochRSI, EMA200 trend filter, Volume, Pattern
 * No AI. No external signals.
 */

'use strict';

const axios = require('axios');
const { RSI, StochasticRSI, EMA } = require('technicalindicators');

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOL       = process.env.BT_SYMBOL   || 'BTCUSDT';
const INTERVAL     = process.env.BT_INTERVAL || '1h';
const LIMIT        = parseInt(process.env.BT_LIMIT || '1000');
const CAPITAL      = parseFloat(process.env.BT_CAPITAL || '20');
const RISK_PCT     = parseFloat(process.env.BT_RISK    || '2');
const MIN_RISK     = parseFloat(process.env.BT_MIN_RISK || '1');
const LEVERAGE     = parseFloat(process.env.BT_LEV     || '5');
const SL_PCT       = parseFloat(process.env.BT_SL      || '1.5');
const TP_PCT       = parseFloat(process.env.BT_TP      || '3.0');
const FIB_LOOKBACK = parseInt(process.env.BT_FIB_LB    || '50');
const MAKER_FEE    = parseFloat(process.env.BT_MAKER_FEE || '0.0002');
const TAKER_FEE    = parseFloat(process.env.BT_TAKER_FEE || '0.0004');

const BASE_URL = 'https://fapi.binance.com';

// ── Fetch ──────────────────────────────────────────────────────────────────────
async function fetchKlines(symbol, interval, limit) {
  const res = await axios.get(`${BASE_URL}/fapi/v1/klines`, { params: { symbol, interval, limit } });
  return res.data.map(k => ({
    ts: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]),
    close: parseFloat(k[4]), volume: parseFloat(k[5]), buyVol: parseFloat(k[9]), totalVol: parseFloat(k[5]),
  }));
}

// ── Fibonacci ────────────────────────────────────────────────────────────────────
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
function fibLevels(high, low) {
  const range = high - low;
  return FIB_LEVELS.reduce((acc, f) => { acc[f] = high - range * f; return acc; }, {});
}
function swingHighLow(candles, lookback) {
  const slice = candles.slice(-lookback);
  return { high: Math.max(...slice.map(c => c.high)), low: Math.min(...slice.map(c => c.low)) };
}
function nearFib(price, fibs, tolerance = 0.003) {
  for (const [level, fibPrice] of Object.entries(fibs)) {
    if (Math.abs(price - fibPrice) / fibPrice < tolerance) return parseFloat(level);
  }
  return null;
}

// ── Pattern ────────────────────────────────────────────────────────────────────
function detectPattern(candles, i) {
  const c = candles[i], p = candles[i-1], pp = candles[i-2];
  if (!p || !pp) return null;
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const bodyRatio = range > 0 ? body / range : 0;

  if (bodyRatio < 0.1) return { name: 'doji', bias: 'neutral' };

  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  if (lowerWick > body * 2 && upperWick < body * 0.5 && c.close > c.open) return { name: 'hammer', bias: 'bull' };
  if (upperWick > body * 2 && lowerWick < body * 0.5 && c.close < c.open) return { name: 'shooting_star', bias: 'bear' };
  if (p.close < p.open && c.close > c.open && c.open < p.close && c.close > p.open) return { name: 'bullish_engulfing', bias: 'bull' };
  if (p.close > p.open && c.close < c.open && c.open > p.close && c.close < p.open) return { name: 'bearish_engulfing', bias: 'bear' };
  if (pp.close < pp.open && Math.abs(p.close-p.open)/(p.high-p.low||1) < 0.3 && c.close > c.open && c.close > (pp.open+pp.close)/2) return { name: 'morning_star', bias: 'bull' };
  if (pp.close > pp.open && Math.abs(p.close-p.open)/(p.high-p.low||1) < 0.3 && c.close < c.open && c.close < (pp.open+pp.close)/2) return { name: 'evening_star', bias: 'bear' };
  return null;
}

// ── Volume ──────────────────────────────────────────────────────────────────────
function volumeSignal(candles, i, period = 20) {
  const slice = candles.slice(Math.max(0, i - period), i);
  const avgVol = slice.reduce((a, c) => a + c.volume, 0) / slice.length;
  const cur = candles[i];
  return { spike: cur.volume / avgVol, buyRatio: cur.buyVol / (cur.totalVol || 1), avgVol };
}

// ── Signal Engine ──────────────────────────────────────────────────────────────
function generateSignal(candles, i, indicators) {
  const { rsi, stochK, stochD, ema20, ema50, ema200, ema20Slope } = indicators;
  const price  = candles[i].close;
  const vol    = volumeSignal(candles, i);
  const pattern = detectPattern(candles, i);

  const { high, low } = swingHighLow(candles.slice(0, i + 1), FIB_LOOKBACK);
  const fibs = fibLevels(high, low);
  const nearLevel = nearFib(price, fibs);

  const uptrend   = price > ema200 && ema20 > ema50;
  const downtrend = price < ema200 && ema20 < ema50;

  if (!uptrend && !downtrend) return { signal: 'SKIP', score: '0.0', reason: 'no_trend', rsi, stochK, stochD, ema20, ema50, fibLevel: nearLevel, pattern: pattern?.name || null, volSpike: vol.spike.toFixed(2), buyRatio: vol.buyRatio.toFixed(2) };

  let score = 0;

  if (rsi < 30)      score += 2;
  else if (rsi < 40) score += 1;
  else if (rsi > 70) score -= 2;
  else if (rsi > 60) score -= 1;

  if (stochK < 20 && stochD < 20)      score += 2;
  else if (stochK < 25)                score += 1;
  else if (stochK > 80 && stochD > 80) score -= 2;
  else if (stochK > 75)                score -= 1;

  if (stochK > stochD && stochK < 50) score += 1;
  if (stochK < stochD && stochK > 50) score -= 1;

  if (ema20 > ema50) score += 1.5; else score -= 1.5;
  if (ema20Slope > 0) score += 1; else score -= 1;
  if (price > ema20)  score += 0.5; else score -= 0.5;

  if (vol.spike < 1.2) return { signal: 'SKIP', score: score.toFixed(1), reason: 'low_volume', rsi, stochK, stochD, ema20, ema50, fibLevel: nearLevel, pattern: pattern?.name || null, volSpike: vol.spike.toFixed(2), buyRatio: vol.buyRatio.toFixed(2) };
  if (vol.buyRatio > 0.6)      score += 1.5;
  else if (vol.buyRatio < 0.4) score -= 1.5;

  if (nearLevel !== null) {
    if ([0.382, 0.5, 0.618].includes(nearLevel)) { if (uptrend) score += 1.5; if (downtrend) score -= 1.5; }
    if (nearLevel === 1.0 && downtrend) score += 1.5;
    if (nearLevel === 0   && uptrend)   score += 1.5;
  }

  if (pattern) {
    if (pattern.bias === 'bull' && uptrend)   score += 2;
    if (pattern.bias === 'bull' && downtrend) score -= 1;
    if (pattern.bias === 'bear' && downtrend) score -= 2;
    if (pattern.bias === 'bear' && uptrend)   score += 1;
  }

  let signal = 'SKIP', reason = 'score_low';
  if (score >= 7)       { signal = 'LONG';  reason = 'strong_long'; }
  else if (score <= -7) { signal = 'SHORT'; reason = 'strong_short'; }

  if (signal === 'LONG'  && !uptrend)  signal = 'SKIP';
  if (signal === 'SHORT' && !downtrend) signal = 'SKIP';

  return { signal, score: score.toFixed(1), reason, rsi: rsi.toFixed(1), stochK: stochK.toFixed(1), stochD: stochD.toFixed(1), ema20: ema20.toFixed(2), ema50: ema50.toFixed(2), fibLevel: nearLevel, pattern: pattern?.name || null, volSpike: vol.spike.toFixed(2), buyRatio: vol.buyRatio.toFixed(2) };
}

// ── Backtest ────────────────────────────────────────────────────────────────────
function runBacktest(candles, allRSI, allStochK, allStochD, allEMA20, allEMA50, allEMA200) {
  let capital = CAPITAL;
  let position = null;
  const trades = [];

  const START = Math.max(200, FIB_LOOKBACK);

  for (let i = START; i < candles.length; i++) {
    const price = candles[i].close, high = candles[i].high, low = candles[i].low;

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
        trades.push({ ts: new Date(candles[i].ts).toISOString(), side: position.side, entry: position.entry, exit: exitPrice, reason: exitReason, pnl: pnl.toFixed(4), capital: capital.toFixed(2), pnlPct: (pnlPct * LEVERAGE * 100).toFixed(2) + '%' });
        position = null;
      }
    }

    if (!position) {
      const rsiIdx = i - (candles.length - allRSI.length);
      const stochIdx = i - (candles.length - allStochK.length);
      const emaIdx20 = i - (candles.length - allEMA20.length);
      const emaIdx50 = i - (candles.length - allEMA50.length);
      const ema200Idx = i - (candles.length - allEMA200.length);

      if (rsiIdx < 0 || stochIdx < 0 || emaIdx20 < 0 || emaIdx50 < 0 || ema200Idx < 0) continue;

      const ema20V = allEMA20[emaIdx20];
      const ema20Prev = allEMA20[emaIdx20 - 1] || ema20V;

      const sig = generateSignal(candles, i, {
        rsi: allRSI[rsiIdx], stochK: allStochK[stochIdx], stochD: allStochD[stochIdx],
        ema20: ema20V, ema50: allEMA50[emaIdx50], ema200: allEMA200[ema200Idx], ema20Slope: ema20V - ema20Prev,
      });

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

// ── Stats ──────────────────────────────────────────────────────────────────────
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
  console.log(`  KalAI Backtest — ${SYMBOL} ${INTERVAL} x${LIMIT}`);
  console.log('════════════════════════════════════════');
  console.log(`  Capital:       $${CAPITAL.toFixed(0)} → $${finalCapital.toFixed(2)}`);
  console.log(`  Total PnL:     $${totalPnl.toFixed(2)} (${((totalPnl/CAPITAL)*100).toFixed(2)}%)`);
  console.log(`  Total Trades:  ${trades.length} (TP: ${tpHits} | SL: ${slHits})`);
  console.log(`  Win Rate:      ${trades.length ? ((wins.length/trades.length)*100).toFixed(1) : 0}% (${wins.length}W / ${loses.length}L)`);
  console.log(`  Profit Factor: ${pf}`);
  console.log(`  Avg R:R:       ${rr}`);
  console.log(`  Max Drawdown:  ${maxDD.toFixed(2)}%`);
  console.log(`  Fees:          Maker ${MAKER_FEE*100}% | Taker ${TAKER_FEE*100}%`);
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

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[BT] Fetching ${LIMIT} ${INTERVAL} candles for ${SYMBOL}...`);
  const klines = await fetchKlines(SYMBOL, INTERVAL, LIMIT);
  console.log(`[BT] Got ${klines.length} candles. Running backtest...`);

  const closes = klines.map(k => k.close);
  const allRSI = RSI.calculate({ values: closes, period: 14 });
  const stoch = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
  const allStochK = stoch.map(s => s.k), allStochD = stoch.map(s => s.d);
  const allEMA20 = EMA.calculate({ values: closes, period: 20 });
  const allEMA50 = EMA.calculate({ values: closes, period: 50 });
  const allEMA200 = EMA.calculate({ values: closes, period: 200 });

  const { trades, finalCapital } = runBacktest(klines, allRSI, allStochK, allStochD, allEMA20, allEMA50, allEMA200);
  printStats(trades, finalCapital);
}

main().catch(e => { console.error(e.message); process.exit(1); });
