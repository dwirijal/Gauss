# Signal-Redesign Study 4 — 90-Day Confirmatory Backtest (GATE PASSED)

_Generated: 2026-07-11 · conclusion of the high-WR research arc._

## Data
- Source: `research3/dataset3.json`, 3 symbols (BTC/ETH/SOL).
- Window: 2026-04-12 → 2026-07-11 (**90 days, multi-regime**).
- Bars/symbol: 5m=25920 (0 gaps), 1h=2160 (0 gaps). Harvested w/ `research3/harvest3.js` (axios, incremental writes).

## Design (validated)
- **HTF bias**: 1h EMA(50) slope. BULL if >+0.15%, BEAR if <-0.15%, else FLAT.
- **Entry** (5m bar close): LONG only in BULL, SHORT only in BEAR. Confluence ≥1 of:
  1. StochRSI(14) **cross** turn (prev.k<25 & prev.k≤prev.d & cur.k>cur.d for LONG; mirror for SHORT),
  2. price near fib 0.382/0.5/0.618 of 1h swing (tol 0.15%),
  3. barPos proxy (close position in bar >0.5 for LONG, <0.5 for SHORT).
- **Exit** (model ii): asymmetric TP 0.6% / SL 0.3%, trailing 0.15%, BE lock at 50% TP — on 5m bars.
- **Single open position per symbol** (no overlap). Money: capital $20, lev 5, risk $1, taker 0.04% rt.

## Results (single-position, 90d) — source of truth: `research3/proto_d90.js`
| Symbol | Trades | WR | Net | CI95 |
|--------|--------|-----|------|------|
| BTCUSDT | 1646 | 61.1% | +221.42 | [60.0, 62.4] |
| ETHUSDT | 2029 | 61.1% | +332.73 | [60.1, 62.3] |
| SOLUSDT | 2608 | 58.9% | +420.48 | [58.0, 59.9] |
| **Total** | **6283** | **60.2%** | **+974.63** | **[59.6, 60.8] |

## Gate Decision (CTO loop step 3)
Criteria: WR≥50% AND net>0 AND ≥200 independent trades AND CI-lower>45%, on the 90d window.
- **ALL FOUR MET for every symbol.** Gate: **PASSED.**

## Recommendation
**DEPLOY** the HTF-bias engine (replaces the net-negative counter-trend signal; live eval was 16.5% WR / −$338). BTC primary, ETH + SOL fast-follow (all clear). Params:
`slopeThPct=0.15, confluenceMin=1, tpPct=0.6, slPct=0.3, trailPct=0.15, beLockAtPct=0.3, maxOpenPerSymbol=1, htf=1h EMA50, entry=5m, stochPeriod=14`.

## Caveats
- OHLCV bar-close fills; live tick/slippage may differ slightly. Live orderbook-depth 4th signal (unbacktestable) is NOT used here — adding it post-deploy could further lift WR.
- Testnet/demo keys only (BINANCE_DEMO2); no real funds. Gate the live rollout on a forward eval before any capital.
- `proto_e.js` (loose entry) showed 38% — a reminder that entry strictness, not just the regime idea, drives WR. Validated `proto_d90.js` logic is the source of truth.
