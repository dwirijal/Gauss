# KalAI WR Study Report — CTO Loop Step 3 Synthesis

_Generated: 2026-07-11 · scope: deploy-gate check for config/filter changes vs live baseline (gate=2, RR1:1 TP=SL=0.4%, trail 0.15%)._

## Summary

The live strategy is net-negative across every measurement. Three independent studies agree: the engine does not currently trade at a profitable win rate on this regime, and **no configuration or filter in scope raises BOTH win rate and net PnL above the live baseline on the same data**. Per the CTO-loop rule ("never deploy a change yielding lower WR or net profit than current live"), the correct decision is **DEPLOY NOTHING**.

Note: `wr_study_harvest.json` was missing and could not be regenerated (Binance API IP rate-limit, HTTP 429, exit 124). The robust multi-day baseline below is taken from the same live config inside `wr_study_sweep.json`, which covered 5,760 bars / 3 symbols / 4 days — the most reliable same-config sample available.

## Robust WR (95% CI)

| Source | Sample | WR | 95% Wilson CI | Net PnL |
|--------|--------|-----|---------------|---------|
| Cited replay harvest (config.json) | 167 trades | 20.8% | 15.5% – 27.8% | n/a |
| **Sweep, same live config (gate2/tp0.4/sl0.4/trail0.15)** | **1,714 trades** | **16.8%** | **15.1% – 18.7%** | **−$234.14** |
| Live eval (`reports/last_eval.json`) | 79 trades | 16.5% | 9.9% – 26.2% | −$338.69 |

**Is 20.8% stable or noise? NOISE.** The 20.8% replay point estimate (15.5–27.8% CI) fully contains the 16.8% multi-day sweep result and overlaps the 16.5% live eval. The 20.8% came from a 167-trade narrow replay labeled a "local optimum"; on a 10× larger same-config sample the true WR is ~16–17%. **Robust WR ≈ 16.17%, 95% CI ≈ 15–19%.** The baseline is net-negative and statistically indistinguishable from the higher replay number.

## Best Config (from `wr_study_sweep.json`, 80 combos)

- `anyConfigProfitable: True` but only on non-live-compatible gate=3 configs with ≤5 trades (noise).
- `liveCompatibleProfitable: False` and `liveCompatibleWRgt50: False`.
- Best **live-compatible** config found: `gate=2, tp=1, sl=1, trail=0.1` → WR **0.7%**, net **−$38.45** (1,673 trades).
- Best **overall** (not deployable): `gate=3, tp=1, sl=0.4, trail=0.5` → WR 40%, net **+$1.5**, but only **5 trades** and violates the live gate=2 constraint.
- **No grid config raises both WR and net PnL vs baseline.** Every live-compatible config loses money and sits far below 16.8% WR.

## Best Filter (from `wr_study_filters.json`)

- Baseline (all triggers, ~4,500 bars/symbol): WR 11.9% (BTC), 19.6% (ETH), negative net everywhere.
- Best positive delta: filter `d` — ETH 4/6 (66.7%, +$0.07), BTC 1/3 (33.3%, +$0.02); but samples are 3–6 trades — **statistically meaningless**.
- All other filters (`a`,`b`,`c`,`e`) show equal-or-lower WR and deeper net losses vs baseline.
- **No filter raises both WR and net PnL on an adequate sample.** Positive deltas are tiny-sample artifacts.

## Caveats

1. **Depth/orderbook-imbalance trigger (live 4th signal) is OMITTED** from all three studies — no historical L2 data. Live performance may differ (higher or lower) from these 3-trigger replays. The 4th signal is the only live-only edge and is not represented here.
2. Replay uses bar-close fills only; live fills at signal tick may differ.
3. Harvest (`wr_study_harvest.json`) could not be regenerated due to Binance IP rate-limiting; robust multi-day estimate substituted from the sweep's identical config.
4. Capital note from generator: stated $20 capital under-collateralizes the $1 risk (notional/lev = $50/position); position sizing assumption differs from live.
5. All studies span a 3–4 day counter-trend chop regime; out-of-sample regime change is untested.

## Recommendation

**DEPLOY NOTHING.** No config or filter in scope beats the live baseline on both WR and net PnL — the hard CTO-loop gate fails on every candidate. The cited 20.8% replay is noise (CI 15.5–27.8%), not a stable edge; robust WR is ~16.8% (CI 15.1–18.7%) and net-negative. The only live-compatible improvements found are net-losing; the only profitable grid points are non-live-compatible 5-trade artifacts. Keep current config. Revisit only after: (a) adding the depth/orderbook 4th signal to replay, and (b) a regime-aware or signal-quality change that clears both WR and PnL gates on a same-data backtest.
