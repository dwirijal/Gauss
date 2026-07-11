# Signal-Redesign Study 3 — Single-Position Correction (CTO Loop Step 3)

_Generated: 2026-07-11 · scope: Proto D (single-position) independent-trade correction vs Proto C (overlapping)._

## Data

- Source: `research2/dataset2.json` — BTCUSDT, ETHUSDT, SOLUSDT.
- Window: 2026-06-29T06:34Z → 2026-07-11T18:33Z (~12.5 days).
- Bars/symbol: 1m=18000, 5m=3601, 15m=1201, 1h=301.
- Live engine baseline (ref): 79 trades, 16.5% WR, −$338 (kalai/reports/eval_1783784043179.md).
- Design (Proto D, `proto_d.js`): 1h EMA50 slope bias (BULL>+0.15% / BEAR<−0.15%); 5m entry StochRSI(14) turn OR fib-near OR barPos proxy, confluence≥1; **max ONE open position/symbol** (block re-entry for holding bars); exit model ii (TP0.6/SL0.3/trail0.15/BE@50%TP); Cap$20 lev5 risk$1 fee0.04%rt.

## Independent-Trade Correction (the real number)

Proto C counted overlapping per-bar signals as trades (3 positions open at once). Proto D enforces one position/symbol → trades are truly independent round-trips.

| Symbol | Proto C (overlap) | **Proto D (independent)** | % of Proto C |
|--------|-------------------|---------------------------|--------------|
| BTCUSDT | 1484 | **156** | 10.5% |
| ETHUSDT | 1352 | **192** | 14.2% |
| SOLUSDT | 1126 | **202** | 17.9% |
| **Total** | **3962** | **550** | **13.9%** |

Proto C's 3962 was an overlap artifact; **550 is the TRUE independent trade count** for the 12.5-day window.

## Per-Symbol Results (independent)

| Symbol | Trades | WR | Net$ | 95% CI | CI-lo | MedianBars |
|--------|--------|-----|------|--------|-------|-----------|
| BTCUSDT | 156 | 64.1% | +17.44 | [61.5, 69.1] | 61.5 | 8 |
| ETHUSDT | 192 | 65.1% | +41.44 | [62.7, 69.5] | 62.7 | 7 |
| SOLUSDT | 202 | 56.4% | +24.17 | [53.9, 60.8] | 53.9 | 6 |
| **Pooled** | 550 | 61.6% | +83.05 | [59.9, 64.1] | 59.9 | — |

## Gate Decision (WR≥50%, net>0, ≥200 independent trades, 95% CI-lower>45%)

| Symbol | WR≥50 | net>0 | ≥200 trades | CI-lo>45 | GATE |
|--------|-------|-------|-------------|----------|------|
| BTCUSDT | ✓ | ✓ | ✗ (156) | ✓ | **NO** |
| ETHUSDT | ✓ | ✓ | ✗ (192) | ✓ | **NO** |
| SOLUSDT | ✓ | ✓ | ✓ (202) | ✓ | PASS* |

\* SOL passes numerically but is **excluded by design**: thinnest net (+$0.12/trade), BEAR-regime bleed, flagged exclude in Studies 1–2. The intended deploy candidate, BTC (and fast-follow ETH), **fail the ≥200 independent-trade bar**.

**Conclusion: GATE NOT CLEARED.** No high-quality symbol reaches 200 independent trades on the 12.5-day slice. The edge does NOT collapse under single-position — BTC 64.1% (vs 66.7% overlapping) and ETH 65.1% (vs 67.2%) hold strong; Proto C's 70% was ~partially real, not a pure artifact. Under-sampling, not a dead edge, is the blocker.

## Days Needed to Reach 200 Independent Trades (extrapolated)

Trades/day: BTC 12.5, ETH 15.4, SOL 16.2.

- BTC: 200 / 12.5 = **16.0 days** (~+3.5 days from now)
- ETH: 200 / 15.4 = **13.0 days** (~+0.5 days from now)
- SOL: already at 202.

A 12.5-day window is structurally too short for BTC/ETH to clear 200 independent trades at ~8–15 trades/day.

## Recommendation

**NO DEPLOY.** Do not ship on under-sampled data. The statistical bars (WR, net, CI-lower) are cleared for BTC & ETH with large margin; only the trade-count bar fails. BTC remains the prime deploy candidate; ETH a fast-follow; SOL excluded. Run a **90-day multi-regime confirmatory backtest** (not the current 12.5-day, BEAR-only-10% slice) to reach ≥200 independent trades/symbol and re-check the gate. Instrument the live bot now to log signal→fill outcomes so the uncapturable orderbook-depth 4th signal becomes measurable.

## Next Steps

1. Extend `harvest2.js` window to ~90 days; re-run `proto_d.js`; confirm BTC/ETH ≥200 independent trades and gate holds across regimes.
2. Instrument live bot: per-trade log of signal timestamp, side, fill px, exit px, reason — measure 4th-signal (L2 depth) contribution.
3. Keep SOL excluded pending ADX<20 regime filter to cut bleed; ETH paused behind BTC confirmation.
4. On 90-day gate pass: deploy BTC-only HTF-bias (params above), ETH fast-follow.

## Caveats

- BTC/ETH fail only on trade count; edge strength (CI-lo 61–63%) is not in question.
- 12.5-day window, BEAR only ~10% — weak multi-regime test despite "multi-regime" label.
- Bar-close fills only; live tick fills may differ.
- `buyRatio` proxied (barPos), not real sentiment feed.
- Orderbook-depth 4th signal absent (no historical L2) — only live instrumentation can resolve it.
