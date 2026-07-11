export const meta = {
  name: 'kalai-htf-single-position',
  description: 'CORRECTION STUDY D. Proto C found WR 65-72% with positive net for HTF-bias mean-reversion (confluence>=1, slope +/-0.15%, asymmetric exit), but used OVERLAPPING per-bar positions (3962 trades) — inflating count and likely WR. This re-runs with a REALISTIC single open position per symbol (no overlapping entries) on the already-harvested 12-day dataset. Goal: measure TRUE independent trade count + WR. If BTC clears WR>=50% AND >=200 independent trades AND net>0, that is a deploy candidate. Else it was an artifact.',
  phases: [
    { title: 'Single-position replay', detail: 'Reuse research2/ 12d data; one open position/symbol; asymmetric exit; count INDEPENDENT trades' },
    { title: 'Synthesize gate D', detail: 'True trade count + WR per symbol; deployable? Write STUDY3.md' },
  ],
};

// Reuse research2/ files (already harvested, no network). Read proto_htf.js / proto_c.js for the entry logic.
const proto = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. Prototype D: HTF-BIAS MEAN-REVERSION, REALISTIC SINGLE-POSITION (correcting Proto C's overlapping-position flaw).

CONTEXT: read research2/dataset2.json + research2/m5_*.json + research2/h1_*.json (12-day multi-regime window already harvested — DO NOT fetch network). Read research/proto_htf.js and research2/proto_c.js to reuse the HTF-bias entry logic.

CRITICAL FIX vs Proto C: Proto C opened a new position every 5m bar (overlapping, 3962 trades). THIS must hold AT MOST ONE open position per symbol at a time. State machine per symbol:
- If no open position AND a 5m bar produces a signal (HTF 1h slope gives BULL -> LONG, BEAR -> SHORT; confluence >=1 of stoch-turn / fib-near / buyRatio-proxy), OPEN at that bar's close.
- Track the open position bar-by-bar on 5m (or finer if you prefer, but use the 5m close series consistently). Exit using exit model (ii) ASYMMETRIC TP 0.6% / SL 0.3%, trailing 0.15%, BE lock at 50% TP (mirror backtest_live.js simulate() mechanics, adapted to 5m bars).
- Do NOT open a new position until the current one closes (TP/SL/trail). This yields INDEPENDENT round-trips.

Compute for BTCUSDT, ETHUSDT, SOLUSDT and total:
- INDEPENDENT trades, wins, losses, WR, net PnL (capital $20, risk $1/trade, lev 5, taker 0.04% rt), 95% Wilson CI.
- Also report holding-period distribution (median bars in trade) so we know how many independent trades a given window yields.
- Compare against Proto C's numbers to show how much the overlap inflated things.

Implement: write research2/proto_d.js (cwd=kalai). Save research2/htf_singlepos.json:
{ design, window, perSymbol:[{sym,independentTrades,wr,netPnl,ci95,medianBars}], total:{independentTrades,wr,netPnl,ci95}, protoC_compare:{sym:{protoC_trades,protoC_wr}}, note }.

Return: <=180-word verdict. TRUE independent trade count? Does BTC (and ETH/SOL) clear WR>=50% AND >=200 independent trades AND net>0? Exact numbers. If independent trades <200, state the window length needed (e.g. N days) to reach 200.`,
  { label: 'proto-d', phase: 'Single-position replay' }
);

const synth = await agent(
  `Working directory: /home/dwizzy/dwizzyOS/gauss/kalai. SYNTHESIZER for study D (single-position correction).

Read: research2/dataset2.json, research2/htf_singlepos.json, research2/SIGNAL_REDESIGN_STUDY2.md, research/SIGNAL_REDESIGN_STUDY.md, kalai/reports/eval_1783784043179.md (live eval: 79 trades, 16.5% WR, -$338).

GATE (CTO loop step 3): deployable only if WR>=50%, net>0, AND >=200 INDEPENDENT trades, 95% CI lower >45% — on the 12-day window (independent-trade corrected).

Decide:
1. TRUE independent trade count per symbol (Proto D). Proto C's 3962 was overlapping; this is the real number.
2. Does BTC (or any symbol) clear the gate on INDEPENDENT trades? If yes: recommend DEPLOY BTC-only HTF-bias (params: HTF 1h slope +/-0.15%, confluence>=1, exit TP0.6/SL0.3 trail0.15, 5m entries) with the SOL/ETH exclusion noted. If independent trades <200 even for BTC: state the window (days) needed to reach 200 and recommend a 90-day confirmatory backtest before deploy — do NOT deploy on under-sampled data.
3. If the edge collapses under single-position (WR drops below 50%): conclude Proto C's 70% was an overlap artifact; recommend stopping OHLCV backtests and instrumenting the live bot to log signal->fill outcomes (to measure the uncapturable live orderbook-depth 4th signal).

Write research2/SIGNAL_REDESIGN_STUDY3.md (Data, Independent-trade correction, Per-symbol results, Gate decision, Recommendation, Next steps, Caveats). Return <=200-word recommendation. Do NOT modify bot code.`,
  { label: 'synth-d', phase: 'Synthesize gate D' }
);

return { proto, synth };
