export const meta = {
  name: 'kalai-wr-rigor-study',
  description: 'Rigorous statistical characterization of KalAI live counter-trend strategy on multi-day 1m history, plus search for any live-compatible profitable config. Gates any deploy per CTO loop step 3.',
  phases: [
    { title: 'Harvest + faithful replay', detail: 'Paginate >=3d 1m klines; replay exact live exit; robust WR + 95% CI' },
    { title: 'Parameter sweep', detail: 'SL/TP/trail/gate grid; find any live config WR>50% or +net PnL' },
    { title: 'Compatible filters', detail: 'Shorter-horizon trend filters compatible with counter-trend' },
    { title: 'Synthesize + gate', detail: 'Combine; decide deploy/nothing; write REPORT.md' },
  ],
};

// Three independent studies run in parallel (Phase 1), then synthesis (Phase 2).
const [harvest, sweep, filters] = await parallel([
  () => agent(
    `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. You are studying the LIVE KalAI futures strategy (counter-trend mean-reversion engine on 1m candles).

CONTEXT — read these first:
- strategy.js: analyze() scores signals. score = StochRSI oversold/overbought-turn (±1) + VWAP deviation ±0.15% (±1) + volume-spike breakout (±1). Entry fires when |score|>=2 (LONG if >=2, SHORT if <=-2). NOTE: the 4th live trigger (orderbook depth imbalance) has no historical L2 data — omit it; document this caveat.
- index.js: read handleSignal() and the position monitor logic. The LIVE exit model: RR 1:1 (TP_PCT == SL_PCT), bot-managed trailing stop at 0.15%, breakeven lock when price reaches 50% of TP target. backtest_live.js simulate() already mirrors this — reuse/extend it.
- backtest_live.js: existing replay harness. Reuse its score()/simulate() but FIX the data window.

TASK:
1. Build a faithful replay backtester that paginates Binance PUBLIC 1m klines (GET https://fapi.binance.com/fapi/v1/klines?symbol=X&interval=1m&limit=1500, paginate via startTime/endTime) to assemble >=3 days (>=4320 bars) of 1m history for BTCUSDT, ETHUSDT, SOLUSDT. No auth needed.
2. Replay the EXACT live logic (score>=2 gate, RR1:1 TP=SL=0.4%, trail 0.15%, BE lock at 50% TP) bar-by-bar.
3. Report: total trades, WR, net PnL (capital $20, risk $1/trade, leverage 5, taker fee 0.04% round-trip), 95% Wilson confidence interval on WR, per-symbol breakdown, date range tested.
4. Write full results to /home/dwizzy/dwizzyOS/gauss/kalai/wr_study_harvest.json (structured: {range, perSymbol:[{sym,trades,win,loss,wr,netPnl}], total:{trades,wr,ci95}, caveat}).

Be exhaustive and correct. Cross-check replay against index.js mechanics line-by-line. Return a concise verdict: is the live strategy profitable on robust data, and is the prior 20.8% (16h sample) estimate statistically stable or noise?`,
    { label: 'harvest-replay', phase: 'Harvest + faithful replay' }
  ),
  () => agent(
    `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. You are sweeping parameters of the LIVE KalAI counter-trend strategy.

Paginate Binance public 1m klines yourself (GET https://fapi.binance.com/fapi/v1/klines?symbol=X&interval=1m&limit=1500, paginate startTime/endTime) to build >=3 days of 1m history for BTCUSDT, ETHUSDT, SOLUSDT.

STRATEGY: counter-trend on 1m, score same as strategy.js (StochRSI turn + VWAP dev + vol-spike breakout; depth trigger omitted).

SWEEP GRID (keep score gate at 2 unless noted):
- gate ∈ {2, 3}
- RR1:1 equal ratios TP_PCT=SL_PCT ∈ {0.2, 0.3, 0.4, 0.5, 0.75, 1.0}
- asymmetric: {TP:0.5/SL:0.25}, {TP:1.0/SL:0.4}, {TP:0.4/SL:0.8}, {TP:0.3/SL:0.6}
- trail ∈ {0.1, 0.15, 0.25, 0.5}

For EACH combo compute WR + net PnL (capital $20, risk $1, lev 5, taker 0.04% rt) across all 3 symbols. Report top 5 configs by net PnL and top 5 by WR. Explicitly state whether ANY live-compatible config reaches WR>50% OR positive net PnL. Write to /home/dwizzy/dwizzyOS/gauss/kalai/wr_study_sweep.json.

Return: is there ANY parameterization of the current counter-trend engine that is profitable? If yes, exact best config + measured WR/net PnL. If no, the best-but-still-unprofitable config.`,
    { label: 'param-sweep', phase: 'Parameter sweep' }
  ),
  () => agent(
    `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. You are testing TREND/RANGE filters COMPATIBLE with a counter-trend mean-reversion engine.

KNOWN FACT: full HTF-bias filter (only LONG in 1h BULL / SHORT in 1h BEAR) is MUTUALLY EXCLUSIVE with counter-trend signals → 0 trades. Do NOT re-test. Test SHORTER-horizon filters:

Build >=3 days of 1m history for BTCUSDT/ETHUSDT/SOLUSDT via paginated Binance public klines (limit=1500, paginate startTime/endTime). Derive 15m and 1h bars from 1m.

Filters (each vs unfiltered baseline, gate=2, RR1:1 TP=SL=0.4%, trail 0.15%):
(a) 15m EMA(50) slope filter: skip LONG if 15m EMA slope < -0.3%, skip SHORT if > +0.3%.
(b) Micro-momentum guard: skip LONG if price made new 20-bar low within last 5 bars; skip SHORT if new 20-bar high within last 5 bars.
(c) Volatility gate: skip if 1m ATR% > 0.8% at signal.
(d) VWAP distance cap: only LONG if price > 0.5% below VWAP, SHORT if > 0.5% above (stronger extremes).
(e) Session filter: skip 00:00-04:00 UTC.

For each: trades retained (% baseline), WR, net PnL, delta vs baseline. Identify filters improving WR by >=5pp WITHOUT dropping trades below 50% of baseline. Write to /home/dwizzy/dwizzyOS/gauss/kalai/wr_study_filters.json.

Return: best COMPATIBLE filter, exact rule, measured delta (WR pp, net PnL). If none help, say so.`,
    { label: 'compatible-filters', phase: 'Compatible filters' }
  ),
]);

const synthesis = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. CTO-loop synthesizer. Read:
- wr_study_harvest.json  (robust WR + 95% CI on multi-day data)
- wr_study_sweep.json    (parameter grid, best profitable config if any)
- wr_study_filters.json  (compatible filters, best delta if any)

SYNTHESIZE + decide per CTO loop step 3: NEVER deploy a change yielding lower WR or net profit than current live (measured ~20.8% replay / 16.5% eval_trades, gate=2, RR1:1 0.4%, trail 0.15%).

Deliverables:
1. True robust WR with 95% CI and data range. Is 20.8% stable or noise?
2. Is ANY improvement deployable (config and/or filter) — only if it raises BOTH WR and net PnL vs baseline on same data.
3. Recommendation: DEPLOY NOTHING / DEPLOY config X / DEPLOY filter Y. If deploying, give exact knob values.
4. State caveat clearly: depth/orderbook trigger (live-only, 4th signal) is omitted.
5. Write final report to /home/dwizzy/dwizzyOS/gauss/kalai/wr_study_REPORT.md (Summary, Robust WR, Best Config, Best Filter, Caveats, Recommendation).

Return recommendation in <=200 words. Do NOT modify bot code — only write the report.`,
  { label: 'synthesizer', phase: 'Synthesize + gate' }
);

return { harvest, sweep, filters, synthesis };
