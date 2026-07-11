# Signal-Redesign Study 2 — CTO Loop Step 3 Synthesis

_Generated: 2026-07-11 · dataset: `research2/dataset2.json` (longer, multi-regime window)._

## Data
- Source: `research2/dataset2.json` — BTCUSDT, ETHUSDT, SOLUSDT.
- Window: 2026-06-29T06:34Z → 2026-07-11T18:33Z (~12 days).
- Bars/symbol: 1m=18000, 5m=3601, 15m=1201, 1h=301.
- Design (`htf_scale.json`): 1h EMA50 slope bias (BULL >+0.15%, BEAR <-0.15%, widened), LONG-only in BULL / SHORT-only in BEAR. 5m entry: StochRSI(14) turn OR fib-near 0.382/0.5/0.618 OR buyRatio proxy (barPos>0.5 BULL / <0.5 BEAR); confluence>=1. 3 exit models on identical entries. Cap $20, lev 5, risk $1, fee 0.04% rt. PnL scaled 0.4%=$1.

## Regime Split (representative, BTC; all syms similar)
- BULL 1704 · BEAR 360 · FLAT 1537 (5m bars). Multi-regime but FLAT/BULL-dominated; BEAR only 10% of window.

## Exit Comparison (per-bar signals, overlapping positions; HORIZON=120 5m bars=10h, forced exit at last px)
| Exit | BTC WR (net, n, CI-lo) | ETH WR (net, n, CI-lo) | SOL WR (net, n, CI-lo) |
|------|------------------------|------------------------|------------------------|
| i (horizon hold) | 71.5% (+210, 1484, 70.5) | 72.6% (+295, 1352, 71.5) | 65.3% (+72, 1126, 64.0) |
| ii (TP/SL) | 66.7% (+290, 1484, 65.6) | 67.2% (+370, 1352, 66.0) | 60.6% (+158, 1126, 59.3) |
| iii (trail) | 47.6% (+364, 1484, 46.5) | 46.2% (+137, 1352, 45.0) | 19.7% (−384, 1126, 18.7) |

Exit **i** is the clear winner and the only model clearing every numeric threshold for all three symbols.

## Gate Decision
Gate = WR≥50% AND net>0 AND ≥200 trades AND 95% CI lower >45%, on this longer multi-regime dataset.

- **Numerically:** Exit i clears for BTC (71.5/CI 70.5), ETH (72.6/CI 71.5), SOL (65.3/CI 64.0). All beat every threshold on the reported counts.
- **Deployability failure:** All runs use *per-bar overlapping positions* ("overlapping positions possible"). Under a realistic one-position-at-a-time rule, a 10h hold over a 12-day window yields ~28 independent round-trips per symbol — far below the 200-trade gate. The 1484 "trades" are non-independent artifacts, not deployable sample size.
- **Verdict: GATE NOT CLEARED for deployment.** The 71.5% is a *real per-round-trip* edge (mean-reversion DOES scale to high WR), but it is under-sampled and non-independent on this dataset — not gate-clean.

## Recommendation
Do **not** deploy. The technical signal reaches high WR, but the sample is not deployable/independent on this 12-day slice.
- **Exclude SOL**: thinnest net (+$72 / 1126 trades ≈ $0.06/trade) and regime-bleed prone (BEAR windows).
- **ETH** clears cleanly (72.6%) — hold as fast-follow once single-position WR is confirmed.
- **BTC** is the prime candidate (highest CI, prior 61.5% directional read corroborates).

## Next Steps
1. **Re-run exit i with single-position rule** on a ≥90-day multi-regime window to reach ≥200 independent trades; re-check the gate (WR, net, CI-lower>45).
2. **Instrument the live bot now** to log signal→fill outcome per trade so the uncaptured **orderbook-depth 4th signal**'s real contribution is measurable. This is the only unbacktestable edge and the highest-value measurement — more OHLCV backtests are lower yield.
3. Keep ETH paused behind BTC confirmation; keep SOL excluded pending a regime filter (e.g., ADX<20) to cut bleed.

## Caveats
- Per-bar overlapping positions inflate trade count and violate independence — the core reason the gate is not met deployably.
- 12-day window, BEAR only 10%; not a strong multi-regime test despite label.
- Bar-close fills only; live tick fills may differ.
- `buyRatio` proxied (barPos), not real sentiment feed.
- Orderbook-depth 4th signal absent from all studies (no historical L2) — could raise or lower live WR either way.
