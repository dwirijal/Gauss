export const meta = {
  name: 'kalai-signal-redesign',
  description: 'The live counter-trend engine is structurally unprofitable (rigor study: WR ~16%, net -$234, no parameterization profitable). This study harvests a clean multi-day dataset ONCE, then prototypes two redesigned signal families that could reach high WR, and synthesizes a deploy target. CTO loop step 3 still gates: do not deploy anything that fails to beat baseline on the same data.',
  phases: [
    { title: 'Harvest dataset', detail: 'Paginate >=5d 1m klines BTC/ETH/SOL; derive 5m/15m/1h; save to research/' },
    { title: 'HTF-bias prototype', detail: 'Rebuild backtest_v3-method (HTF bias + fib + LTF stoch + buyRatio proxy) on 5m; measure WR/net' },
    { title: 'Range-gated counter-trend', detail: 'Keep counter-trend but fire only in CHOPPY/range regimes + 15m EMA confluence; measure' },
    { title: 'Synthesize', detail: 'Rank candidates by WR + net PnL; recommend deploy target + exact params; write STUDY.md' },
  ],
};

const DATE = '2026-07-11';

// PHASE 1 — harvest once. Agents 2/3/4 consume the saved files.
const harvest = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. You are the DATA HARVESTER for a trading-signal redesign study.

GOAL: build a clean, reproducible multi-day historical dataset and save it to disk so other study agents can read it (avoid re-fetching / rate limits).

STEPS:
1. Write a script research/harvest.js (run with cwd=/home/dwizzy/dwizzyOS/gauss/kalai so it can require('axios') and require('technicalindicators') from kalai/node_modules).
2. Fetch 1m klines from Binance FUTURES PUBLIC endpoint (no auth):
   GET https://fapi.binance.com/fapi/v1/klines?symbol=X&interval=1m&limit=1500
   Paginate using startTime/endTime to assemble >=5 days (>=7200 bars) ending as close to the latest available as possible for BTCUSDT, ETHUSDT, SOLUSDT. Use a 1s sleep between pages to be polite; cap at ~6 pages per symbol.
   Each bar: [openTime, open, high, low, close, volume, closeTime, ...]. Keep {t,o,h,l,c,v}.
3. Save raw 1m to research/raw_<SYMBOL>.json as JSON array of {t,o,h,l,c,v}.
4. From the 1m bars, DERIVE and save:
   - 5m  OHLCV -> research/m5_<SYMBOL>.json
   - 15m OHLCV -> research/m15_<SYMBOL>.json
   - 1h  OHLCV -> research/h1_<SYMBOL>.json
   (group consecutive 1m bars by floor(t/interval_ms); use close of last bar, high=max, low=min, volume=sum.)
5. Write research/dataset.json index: { generated, range:{from,to}, perSymbol:{SYMBOL:{bars1m, bars5m, bars15m, bars1h}}, files:{...} }.

REQUIREMENTS:
- Validate each fetched page is an array and contiguous (no gaps). If a gap, log it but continue.
- Do NOT filter by volatile periods; keep all bars.
- Save everything under research/ (create dir if missing).
- Print a concise summary: range, bar counts per symbol, file paths.

Return: the dataset index JSON (range + counts) and confirm all 6 files written. Do not run any backtests.`,
  { label: 'harvester', phase: 'Harvest dataset' }
);

// PHASE 2 — two prototype designs in parallel, both reading the saved dataset.
const [htf, ct] = await parallel([
  () => agent(
    `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. You are prototyping SIGNAL FAMILY A: HTF-BIAS MEAN-REVERSION (the method that produced the historical "validated" WR of 45-69%).

CONTEXT: read research/dataset.json and the files it lists (research/raw_*.json 1m, research/m5_*.json, research/h1_*.json, research/m15_*.json). Read strategy.js and backtest_live.js to understand the existing engine and its simulate() exit model (RR1:1 TP=SL, trailing 0.15%, BE lock at 50% TP).

DESIGN (rebuild the backtest_v3 method faithfully):
- HTF bias from 1h (and/or 4h) candles: trend = EMA(50) slope over 1h. BULL if slope > +0.3%, BEAR if < -0.3%, else FLAT.
- Only take LONG entries when HTF is BULL; only SHORT when HTF is BEAR. (FLAT = no trades.)
- Entry trigger on 5m bars: LTF StochRSI(14) oversold-turn (<25 then k>d) for LONG, overbought-turn (>75 then k<d) for SHORT, AND price must be near a Fibonacci retracement level of the recent HTF swing (use 0.382/0.5/0.618 of the last 1h swing high-low).
- "buyRatio proxy": since no live orderflow, use 5m volume-weighted close position within the bar (close near high = buyer control) as a proxy for buyRatio>0.5; require it.
- Confluence gate: require >=2 of {stoch-turn, fib-near, buyRatio-proxy} aligned.
- Exit: use the SAME simulate() model as backtest_live.js (RR1:1, TP=SL in {0.4,0.5,0.75}%, trail 0.15%, BE lock at 50% TP).

IMPLEMENT: write research/proto_htf.js (cwd=kalai, require axios/ti). Load saved files (do NOT fetch network). Replay bar-by-bar on 5m using 1h HTF bias computed from h1 bars. For each symbol compute and across all 3 symbols:
- trades, wins, losses, WR, net PnL (capital $20, risk $1/trade, leverage 5, taker fee 0.04% round-trip)
- 95% Wilson CI on WR
- best TP/SL% among {0.4,0.5,0.75} by net PnL
Write results to research/htf_bias.json: { design, params, perSymbol:[{sym,trades,wr,netPnl,ci95}], best:{tp,sl}, total:{trades,wr,netPnl,ci95}, note }.

Return: a <=150-word verdict. Does HTF-bias recover WR>=55% with positive net PnL on this fresh dataset? Give exact measured numbers. If WR<50%, state so plainly.`,
    { label: 'htf-bias', phase: 'HTF-bias prototype' }
  ),
  () => agent(
    `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. You are prototyping SIGNAL FAMILY B: RANGE-GATED COUNTER-TREND (keep the live mean-reversion engine but stop it from trading against trends).

CONTEXT: read research/dataset.json + research/raw_<SYMBOL>.json (1m). Read strategy.js (analyze() pure triggers) and backtest_live.js — reuse its score() and simulate() EXACTLY (this is the faithful live replay). Read classifyRegime() in backtest_live.js (EMA50 slope + ATR% -> BULL/BEAR/CHOPPY).

DESIGN: the live counter-trend fires LONG on oversold+cheap, SHORT on overbought+expensive. The rigor study showed this bleeds because it fights trends. FIX: only allow entries when the regime is CHOPPY (range) — block LONG/SHORT when regime is BULL or BEAR (i.e., require classifyRegime(...) === 'CHOPPY'). Add a 15m EMA(50) slope confluence: for LONG require 15m slope between -0.3% and +0.1% (not strong up-trend); for SHORT require between -0.1% and +0.3% (not strong down-trend). Keep gate=|score|>=2, exit model identical.

TEST VARIANTS (all on 1m, gate=2, RR1:1 TP=SL=0.4%, trail 0.15%):
(a) baseline counter-trend (no regime filter) — for comparison
(b) CHOPPY-only gating
(c) CHOPPY-only + 15m EMA-slope confluence
For each: trades, WR, net PnL across all 3 symbols, per-symbol, 95% CI.

Implement: write research/proto_range.js (cwd=kalai). Reuse score()/simulate()/classifyRegime() logic. Save to research/countertrend_range.json: { design, variants:{a,b,c:{trades,wr,netPnl,ci95,perSymbol}}, note }.

Return: <=150-word verdict. Does range-gating recover WR>=50% with positive net? Which variant is best? Plain numbers.`,
    { label: 'range-gated', phase: 'Range-gated counter-trend' }
  ),
]);

// PHASE 3 — synthesize after prototypes resolve (they've written their json files).
const synth = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. CTO-loop SYNTHESIZER for the signal-redesign study.

Read ALL of these:
- research/dataset.json        (data range + coverage)
- research/htf_bias.json        (Family A results)
- research/countertrend_range.json (Family B results)
- kalai/wr_study_REPORT.md      (prior rigor study: live engine WR ~16.8%, net -$234, structurally unprofitable)

DECISION FRAMEWORK (CTO loop step 3 — never deploy below baseline):
Baseline = live engine measured ~16.8% WR / net -$234. A candidate is DEPLOYABLE only if, on the SAME fresh dataset, it reaches WR >= 50% AND positive net PnL, AND retains enough trades to be statistically meaningful (>=200 trades, 95% CI lower bound > 45%).

For each candidate family, judge:
1. Measured WR + 95% CI + net PnL + trade count.
2. Is it deployable per the gate above? (Be strict.)
3. If neither family passes, state that clearly and recommend the NEXT research direction (e.g., longer HTF lookback, different exit, multi-timeframe confirmation) rather than deploying.

DELIVERABLES:
- Write research/SIGNAL_REDESIGN_STUDY.md with sections: Data, Family A (HTF-bias), Family B (range-gated), Gate Decision, Recommendation, Next Steps, Caveats.
- Recommendation must be ONE of: DEPLOY Family A (params...), DEPLOY Family B variant (params...), DEPLOY HYBRID, or NO DEPLOY — run further research.
- Caveats: live orderbook-depth trigger (4th live signal) is untested here; buyRatio is proxied.

Return: <=200-word recommendation with the exact chosen design + params, or explicit "NO DEPLOY". Do NOT modify bot code.`,
  { label: 'synthesizer', phase: 'Synthesize' }
);

return { harvest, htf, ct, synth };
