export const meta = {
  name: 'kalai-btc-htf-longwindow',
  description: 'Decisive test: can technical-signal mean-reversion ever clear a 50% WR gate at scale? Family A (HTF-bias) showed BTC 61.5% but only 13 trades on a 5-day single-regime window. This harvests a LONGER multi-regime window (>=12 days), relaxes the confluence gate to lift trade count, and tests ASYMMETRIC + TRAIL-ONLY exits. If BTC clears WR>=50% at >=200 trades with positive net, that is a real deploy candidate. Else the edge requires live orderflow (depth) we cannot backtest.',
  phases: [
    { title: 'Harvest 12d', detail: 'Paginate ~12 days 1m for BTC/ETH/SOL; derive 5m/15m/1h; save research2/' },
    { title: 'BTC-focused HTF-bias @scale', detail: 'Relaxed confluence + asymmetric/trail exits; measure WR/net at >=200 trades' },
    { title: 'Synthesize gate C', detail: 'Does ANY config pass WR>=50%, net>0, >=200 trades, CI>45%? Write STUDY2.md' },
  ],
};

// PHASE 1 — longer window harvest.
const harvest = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. DATA HARVESTER (long window).

Reuse the approach from research/harvest.js but fetch a LONGER window:
- Write research2/harvest2.js (cwd=kalai so require('axios')/require('technicalindicators') resolve).
- Fetch 1m klines from https://fapi.binance.com/fapi/v1/klines?symbol=X&interval=1m&limit=1500 .
- Paginate to assemble >=12 days (>=17000 bars) ending at latest available for BTCUSDT, ETHUSDT, SOLUSDT. ~12 pages/symbol, 1s sleep between pages.
- Save research2/raw_<SYM>.json ({t,o,h,l,c,v}); derive and save research2/m5_<SYM>.json, research2/m15_<SYM>.json, research2/h1_<SYM>.json (group 1m by floor(t/interval_ms)).
- Write research2/dataset2.json index {generated,range:{from,to,fromISO,toISO},perSymbol:{SYM:{bars1m,bars5m,bars15m,bars1h}},files}.
- Validate contiguity on the full series (0 gaps). Note any gaps but continue.
Print summary (range, counts, paths). Do NOT backtest.`,
  { label: 'harvester2', phase: 'Harvest 12d' }
);

// PHASE 2 — BTC-focused HTF-bias at scale with relaxed gate + asymmetric/trail exits.
const proto = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. Prototype C: HTF-BIAS MEAN-REVERSION AT SCALE, MULTI-REGIME WINDOW.

CONTEXT: read research2/dataset2.json + research2/m5_*.json + research2/h1_*.json (and research/proto_htf.js for the prior 5-day version to reuse logic). Read strategy.js + backtest_live.js for the simulate() exit model.

DESIGN — HTF-bias (1h EMA50 slope) + 5m entry, but FIX THE TWO problems that killed Family A:
1. TRADE COUNT: relax confluence to >=1 trigger (stoch-turn OR fib-near OR buyRatio-proxy), and widen HTF slope threshold to +/-0.15% (so more bars read BULL/BEAR, more entries). Keep LONG-only-in-BULL, SHORT-only-in-BEAR.
2. EXIT: test 3 exit models on the SAME entries:
   (i)  RR1:1  TP=SL=0.4%, trail 0.15%, BE lock 50%   [baseline symmetric]
   (ii) ASYMMETRIC TP 0.6% / SL 0.3%, trail 0.15%      [reward > risk]
   (iii) TRAIL-ONLY: no fixed TP, trailing 0.3% callback after 0.2% activation, SL 0.4% hard stop
Measure for each exit model: per-symbol + total trades, WR, net PnL (capital $20, risk $1, lev 5, taker 0.04% rt), 95% Wilson CI.
ALSO report the HTF-regime split: how many bars BULL/BEAR/FLAT over the window (proves multi-regime, not the single-chop artifact).

Implement: write research2/proto_c.js (cwd=kalai). Load saved files, NO network. Save research2/htf_scale.json:
{ design, window:{from,to,bars}, regimeSplit:{BULL,BEAR,FLAT}, exits:{i:{perSymbol,total:{trades,wr,netPnl,ci95}}, ii:{...}, iii:{...}}, note }.

Return: <=180-word verdict. Does BTC (or any symbol) clear WR>=50% AND net>0 AND >=200 trades with any exit? Give exact numbers per exit model. If still fails, say which constraint it misses.`,
  { label: 'proto-c', phase: 'BTC-focused HTF-bias @scale' }
);

// PHASE 3 — synthesize.
const synth = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. SYNTHESIZER for study C.

Read: research2/dataset2.json, research2/htf_scale.json, research/SIGNAL_REDESIGN_STUDY.md, kalai/wr_study_REPORT.md, kalai/reports/eval_1783784043179.md (live: 79 trades, WR 16.5%, net -$338).

GATE (CTO loop step 3): deployable only if WR>=50%, net>0, >=200 trades, 95% CI lower bound >45% — on THIS longer multi-regime dataset.

Decide:
1. Does ANY exit model for ANY symbol clear the gate? (BTC is the prime candidate given prior 61.5% directional read.)
2. If BTC-only clears it: recommend DEPLOY BTC-only HTF-bias with exact params (slope threshold, confluence level, exit model, TP/SL/trail). State the SOL/ETH exclusion explicitly.
3. If NO config clears: conclude technical-signal mean-reversion cannot reach high WR at scale on these symbols, and the live engine's only uncaptured edge is the LIVE orderbook-depth 4th signal (unbacktestable on OHLCV). Recommend next action: instrument the live bot to log signal->fill outcome so depth's real contribution can be measured, rather than more historical backtests.

Write research2/SIGNAL_REDESIGN_STUDY2.md (Data, Regime split, Exit comparison, Gate decision, Recommendation, Next steps, Caveats). Return <=200-word recommendation. Do NOT modify bot code.`,
  { label: 'synth-c', phase: 'Synthesize gate C' }
);

return { harvest, proto, synth };
