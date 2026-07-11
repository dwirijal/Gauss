/**
 * KalAI v4 — 1h momentum capture with trailing adaptive stop
 * Entry: fib level + RSI extreme + volume spike (mean-reversion at key level)
 * Exit: trailing stop (locks profit, captures momentum) OR opposite signal
 * Goal: many trades, 80%+ winrate
 */

'use strict';

const ccxt = require('ccxt');
const { RSI, StochasticRSI } = require('technicalindicators');

const SYMBOL = process.env.BT_SYMBOL || 'BTCUSDT';
const INTERVAL = process.env.BT_INTERVAL || '1h';
const LIMIT = parseInt(process.env.BT_LIMIT || '2000');
const LEVERAGE = 5;
const TAKER_FEE = 0.0004;
const FIB_LOOKBACK = 120;
const MIN_RISK = 1, RISK_PCT = 2, CAPITAL = 20;

function fibLevels(high, low) {
  const range = high - low;
  return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0].reduce((a, f) => { a[f] = high - range * f; return a; }, {});
}
function swingHighLow(candles, lb) {
  const s = candles.slice(-lb);
  return { high: Math.max(...s.map(c => c.high)), low: Math.min(...s.map(c => c.low)) };
}
function nearFib(price, fibs, tol) {
  for (const [lvl, fp] of Object.entries(fibs)) {
    if (Math.abs(price - fp) / fp < tol) return parseFloat(lvl);
  }
  return null;
}
function volumeSignal(candles, i, period = 20) {
  const s = candles.slice(Math.max(0, i - period), i);
  const avg = s.reduce((a, c) => a + c.volume, 0) / s.length;
  return { spike: candles[i].volume / avg };
}

// Trailing stop: once in profit by trailActivate%, SL moves to entry + trailDist% behind
function backtest(candles, cfg) {
  let capital = CAPITAL, pos = null, trades = [], consecLoss = 0, paused = 0;
  const START = 250;
  let lastIdx = START;
  for (let i = START; i < candles.length; i++) {
    lastIdx = i;
    const c = candles[i];
    const price = c.close, high = c.high, low = c.low;

    if (pos) {
      // Update trailing stop
      if (pos.side === 'LONG') {
        const profitPct = (price - pos.entry) / pos.entry * 100;
        if (profitPct >= cfg.trailActivate && price > pos.best) {
          pos.best = price;
          pos.sl = Math.max(pos.sl, price * (1 - cfg.trailDist / 100));
        }
        if (low <= pos.sl) { closeTrade('trail'); continue; }
      } else {
        const profitPct = (pos.entry - price) / pos.entry * 100;
        if (profitPct >= cfg.trailActivate && price < pos.best) {
          pos.best = price;
          pos.sl = Math.min(pos.sl, price * (1 + cfg.trailDist / 100));
        }
        if (high >= pos.sl) { closeTrade('trail'); continue; }
      }
    }

    if (!pos && i >= paused) {
      const vol = volumeSignal(candles, i);
      if (vol.spike >= cfg.volMin) {
        const closes = candles.slice(0, i + 1).map(x => x.close);
        const rsi = RSI.calculate({ values: closes, period: 14 });
        const r = rsi[rsi.length - 1];
        const st = StochasticRSI.calculate({ values: closes, rsiPeriod: 14, stochasticPeriod: 14, kPeriod: 3, dPeriod: 3 });
        const sk = st[st.length - 1].k;
        const { high: sh, low: sl_ } = swingHighLow(candles.slice(0, i + 1), FIB_LOOKBACK);
        const fibs = fibLevels(sh, sl_);
        const nl = nearFib(price, fibs, cfg.fibTol);

        let signal = 'SKIP';
        if (nl !== null && [0, 0.236, 0.382, 0.5, 0.618].includes(nl) && r < cfg.rsiMax && sk < cfg.stochMax) signal = 'LONG';
        else if (nl !== null && [1.0, 0.786, 0.618, 0.5].includes(nl) && r > (100 - cfg.rsiMax) && sk > (100 - cfg.stochMax)) signal = 'SHORT';

        if (signal !== 'SKIP') {
          const qty = Math.max(capital * (RISK_PCT / 100), MIN_RISK);
          const sl = signal === 'LONG' ? price * (1 - cfg.slPct / 100) : price * (1 + cfg.slPct / 100);
          pos = { side: signal, entry: price, qty, sl, best: price };
        }
      }
    }
  }
  function closeTrade() {
    const exit = pos.sl;
    const pnlPct = pos.side === 'LONG' ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry;
    const fee = pos.qty * LEVERAGE * TAKER_FEE * 2;
    const pnl = pos.qty * pnlPct * LEVERAGE - fee;
    capital += pnl;
    if (pnl <= 0) { consecLoss++; if (consecLoss >= 2) paused = lastIdx + 12; } else consecLoss = 0;
    trades.push(pnl);
    pos = null;
  }
  const wins = trades.filter(t => t > 0).length;
  const wr = trades.length ? (wins / trades.length * 100) : 0;
  return { wr: wr.toFixed(1), n: trades.length, pnl: trades.reduce((a, b) => a + b, 0).toFixed(2) };
}

async function main() {
  const ex = new ccxt.binance();
  const bars = await ex.fetchOHLCV(SYMBOL.replace('USDT', '/USDT'), INTERVAL, undefined, LIMIT);
  const candles = bars.map(k => ({ ts: k[0], open: k[1], high: k[2], low: k[3], close: k[4], volume: k[5] }));

  const configs = [];
  for (const rsiMax of [35, 40, 45])
    for (const stochMax of [25, 30, 35])
      for (const slPct of [0.8, 1.0])
        for (const trailActivate of [0.8, 1.2])
          for (const trailDist of [0.5, 0.8])
            for (const volMin of [1.3, 1.5])
              for (const fibTol of [0.005, 0.008])
                configs.push({ rsiMax, stochMax, slPct, trailActivate, trailDist, volMin, fibTol });

  console.log(`Sweep ${SYMBOL} ${INTERVAL} x${LIMIT} — ${configs.length} configs (trailing stop)`);
  console.log('rsi sto sl  traA traD vol fibTol | WR%   N    PnL');
  const results = configs.map(cfg => ({ cfg, ...backtest(candles, cfg) }));
  results.sort((a, b) => parseFloat(b.wr) - parseFloat(a.wr));
  for (const r of results.slice(0, 20)) {
    const c = r.cfg;
    console.log(`${String(c.rsiMax).padEnd(3)} ${String(c.stochMax).padEnd(3)} ${c.slPct} ${c.trailActivate} ${c.trailDist}  ${c.volMin} ${c.fibTol} | ${String(r.wr).padEnd(4)} ${String(r.n).padEnd(3)}  ${r.pnl}`);
  }
  console.log('\n--- Configs with N>=15 and WR>=80% ---');
  const good = results.filter(r => r.n >= 15 && parseFloat(r.wr) >= 80);
  if (good.length === 0) console.log('NONE — need to relax. Best N>=10 WR>=75:');
  results.filter(r => r.n >= 10 && parseFloat(r.wr) >= 75).slice(0, 10).forEach(r => {
    const c = r.cfg;
    console.log(`${String(c.rsiMax).padEnd(3)} ${String(c.stochMax).padEnd(3)} ${c.slPct} ${c.trailActivate} ${c.trailDist}  ${c.volMin} ${c.fibTol} | ${String(r.wr).padEnd(4)} ${String(r.n).padEnd(3)}  ${r.pnl}`);
  });
}
main().catch(e => { console.error(e.message); process.exit(1); });
