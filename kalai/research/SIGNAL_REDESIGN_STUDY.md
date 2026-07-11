# Signal-Redesign Study — CTO Loop Step 3 Synthesis

_Generated: 2026-07-11 · scope: two candidate signal families vs live baseline (WR ~16.8% / net −$234)._

## Data

- Source: `research/dataset.json` — 3 symbols (BTCUSDT, ETHUSDT, SOLUSDT).
- Window: 2026-07-06T13:11Z → 2026-07-11T18:10Z (~5 days).
- Bars/symbol: 1m=7500, 5m=1501, 15m=501, 1h=126.
- Single contiguous chop/range regime. No out-of-sample regime.

## Family A — HTF-bias mean-reversion (`htf_bias.json`)

LT bias (1h EMA50 slope ±0.3%), 5m StochRSI turn + fib-near + buyRatio proxy, confluence≥2, RR1:1.

| Symbol | Trades | WR | Net | 95% CI |
|--------|--------|-----|------|--------|
| BTCUSDT | 13 | 61.5% | +2.48 | [64.4, 88.2]* |
| ETHUSDT | 36 | 38.9% | −9.44 | [36.5, 52] |
| SOLUSDT | 36 | 11.1% | −29.44 | [11.1, 21.8] |
| **Total** | **85** | **30.6%** | **−36.4** | **[27.9, 37.8]** |

*BTC CI >100% is a tiny-sample artifact (13 trades); not meaningful.

## Family B — Counter-trend range-gated (`countertrend_range.json`)

LONG/SHORT on oversold/overbought+VWAP+vol, gated to CHOPPY; variant(c) adds 15m EMA50 slope confluence. TP=SL=0.4%, trail 0.15%, 30-bar fwd.

| Variant | Trades | WR | Net | 95% CI |
|---------|--------|-----|------|--------|
| a / b | 363 | 17.9% | −93.2 | [14.0, 21.9] |
| c | 128 | 21.1% | −29.6 | [14.0, 28.2] |

## Gate Decision

Deploy gate: WR ≥ 50% AND net PnL > 0 AND ≥200 trades AND 95% CI lower > 45%.

| Family | WR≥50 | Net>0 | ≥200 trades | CI lb>45 | Verdict |
|--------|-------|-------|-------------|----------|---------|
| A | ❌ 30.6% | ❌ −36.4 | ❌ 85 | ❌ 27.9% | FAIL |
| B-a/b | ❌ 17.9% | ❌ −93.2 | ✅ 363 | ❌ 14.0% | FAIL |
| B-c | ❌ 21.1% | ❌ −29.6 | ❌ 128 | ❌ 14.0% | FAIL |

**Both families fail on WR, net PnL, and CI lower bound.** Family B-a/b clears only the trade-count bar. Neither is statistically nor economically superior to the live baseline on this data.

## Recommendation

**NO DEPLOY — run further research.**

No candidate reaches the gate. Family A's directional edge is real but sample-starved (BTC 13 trades, total 85 ≪ 200); Family B is structurally net-negative at scale. Neither justifies replacing the (already unprofitable) live engine — deploying either would not beat the baseline on the hard CTO-loop criteria.

## Next Steps

1. Lengthen HTF lookback / widen slope threshold to lift Family A trade count toward ≥200 for a stable WR read; keep RR1:1, add a regime filter (e.g. ADX<20) to cut SOL bleed.
2. Re-engineer Family B exit: trail-only or asymmetric TP (TP 0.6 / SL 0.3) — symmetric 0.4/0.4 with 0.15 trail cannot recover sub-20% WR.
3. Add true **multi-timeframe confluence**: require 15m + 1h agreement before 5m entry, not as a soft add-on.
4. Backtest on a **multi-regime** window (trend + chop weeks) to confirm robustness, not a single 5-day chop slice.

## Caveats

- The live **orderbook-depth 4th signal** is untested in both families (no historical L2) — it is the only live-only edge and could change results either way.
- `buyRatio` is **proxied** (close-position-in-bar > 0.5), not the real sentiment feed; true buyRatio may shift entry quality.
- All studies are bar-close fills; live tick fills may differ.
- Single contiguous regime; out-of-sample regime change untested.
