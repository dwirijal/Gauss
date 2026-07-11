export const meta = {
  name: 'kalai-htf-90d-confirm',
  description: 'CONFIRMATORY 90-day backtest of the HTF-bias mean-reversion edge found in Study D. Proto D (12.5d, single-position) showed BTC 64.1% / ETH 65.1% / SOL 56.4% WR, all net-positive, but BTC(156)/ETH(192) missed the >=200 independent-trade gate. This harvests ~90 days of 5m+1h, replays single-position with the EXACT validated params, and tests whether the edge clears the full CTO gate (WR>=50%, net>0, >=200 trades, CI-lo>45%).',
  phases: [
    { title: 'Harvest 90d', detail: 'Paginate ~90d 5m + 1h for BTC/ETH/SOL; save research3/' },
    { title: '90d single-position replay', detail: 'Validated params (slope +/-0.15%, confluence>=1, exit TP0.6/SL0.3 trail0.15); count independent trades' },
    { title: 'Gate decision', detail: 'Full gate pass? Write STUDY4.md + exact deploy spec' },
  ],
};

const harvest = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. DATA HARVESTER (90-day window).

Write research3/harvest3.js (cwd=kalai). Fetch from Binance FUTURES PUBLIC klines (no auth):
  GET https://fapi.binance.com/fapi/v1/klines?symbol=X&interval=5m&limit=1500   (and interval=1h for HTF bias)
Paginate to assemble ~90 days for BTCUSDT, ETHUSDT, SOLUSDT.
- 5m over 90d = 90*288 = 25920 bars -> ~18 pages/symbol (limit=1500, startTime/endTime pagination, 1s sleep).
- 1h over 90d = 2160 bars -> ~2 pages/symbol.
Each bar [openTime,o,h,l,c,v,...]; keep {t,o,h,l,c,v}.
Save research3/m5_<SYM>.json and research3/h1_<SYM>.json. Write research3/dataset3.json index {generated,range:{fromISO,toISO},perSymbol:{SYM:{bars5m,bars1h}},files}.
Validate full-series contiguity (0 gaps). Note gaps but continue.
Print summary (range, counts, paths). NO backtest.`,
  { label: 'harvester3', phase: 'Harvest 90d' }
);

const proto = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. Prototype E: 90-DAY HTF-BIAS, SINGLE-POSITION, VALIDATED PARAMS.

CONTEXT: read research3/dataset3.json + research3/m5_*.json + research3/h1_*.json (90d, DO NOT fetch network). Read research2/proto_d.js for the single-position state machine to reuse EXACTLY.

ENTRY (validated from Studies C/D): HTF 1h EMA50 slope: LONG if slope > +0.15%, SHORT if < -0.15%; confluence >=1 of {5m StochRSI(14) turn, fib-near of 1h swing, buyRatio-proxy (close-position-in-bar>0.5)}.
STATE MACHINE: max ONE open position per symbol. Open at 5m bar close on signal; exit on exit model (ii) ASYMMETRIC TP 0.6% / SL 0.3%, trailing 0.15%, BE lock at 50% TP (mirror backtest_live.js simulate(), adapted to 5m). No new position until current closes.
Compute BTCUSDT, ETHUSDT, SOLUSDT, total: independent trades, WR, net PnL (capital $20, risk $1, lev 5, taker 0.04% rt), 95% Wilson CI. Report median bars-in-trade.
Save research3/htf_90d.json: {design,window,params,perSymbol:[{sym,independentTrades,wr,netPnl,ci95,medianBars}],total:{independentTrades,wr,netPnl,ci95},note}.

Return: <=180-word verdict. INDEPENDENT trade count per symbol? Do BTC/ETH/SOL clear WR>=50% AND >=200 trades AND net>0? Exact numbers + CI.`,
  { label: 'proto-e', phase: '90d single-position replay' }
);

const synth = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. FINAL SYNTHESIZER — deploy decision.

Read: research3/dataset3.json, research3/htf_90d.json, research2/SIGNAL_REDESIGN_STUDY3.md, research/SIGNAL_REDESIGN_STUDY.md, kalai/reports/eval_1783784043179.md (live counter-trend: 16.5% WR, -$338), kalai/wr_study_REPORT.md.

GATE (CTO loop step 3): deployable only if WR>=50%, net>0, AND >=200 INDEPENDENT trades, 95% CI lower >45%, on the 90-day window.

Decide:
1. Full gate pass per symbol (BTC/ETH/SOL) on INDEPENDENT trades.
2. If BTC (and/or ETH) clears: write an EXACT deploy spec — config knobs to set in kalai/config.json and the entry logic to port into strategy.js/index.js: HTF 1h EMA50 slope +/-0.15% bias, 5m entry, confluence>=1, exit TP0.6%/SL0.3% trail0.15% BE-lock-50%, one-position-per-symbol. Note SOL exclusion if it fails or is thin. State that this REPLACES the counter-trend engine (which is net-negative in live eval).
3. If it decays below gate on 90d (regime change bites): recommend NOT deploying; instrument live bot to log signal->fill and measure L2 depth 4th signal.

Write research3/SIGNAL_REDESIGN_STUDY4.md (Data, Per-symbol gate results, Deploy spec OR no-deploy, Caveats). Return <=200-word recommendation with exact params if deployable. Do NOT modify bot code (only write the report + spec).`,
  { label: 'synth-e', phase: 'Gate decision' }
);

return { harvest, proto, synth };
