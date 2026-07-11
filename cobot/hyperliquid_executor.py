from __future__ import annotations

import json
from pathlib import Path

import os

PAPER = os.getenv('COPYBOT_LIVE', '0') != '1'
MAX_DAILY_LOSS = float(os.getenv('COPYBOT_MAX_DAILY_LOSS', '200'))
MAX_OPEN_POSITIONS = int(os.getenv('COPYBOT_MAX_OPEN_POSITIONS', '3'))
MIN_LIQUIDITY = float(os.getenv('COPYBOT_MIN_LIQUIDITY', '1000000'))
COOLDOWN_AFTER_LOSS = int(os.getenv('COPYBOT_COOLDOWN_AFTER_LOSS_MIN', '30'))
ROOT = Path(__file__).resolve().parent
SIGNALS = ROOT / 'paper_signals.json'
JOURNAL = ROOT / 'trade_journal.json'
ASSET_CTXS = ROOT / 'asset_ctxs.json'
ALL_MIDS = ROOT / 'all_mids.json'

def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def guards_ok(journal):
    total_pnl = sum(float(t.get('pnl', 0) or 0) for t in journal)
    open_pos = sum(1 for t in journal if t.get('status') == 'open')
    recent_loss = next((t for t in reversed(journal) if float(t.get('pnl', 0) or 0) < 0), None)
    if total_pnl <= -MAX_DAILY_LOSS:
        raise SystemExit(f'guard: max daily loss hit ({total_pnl:.2f} <= -{MAX_DAILY_LOSS:.2f})')
    if open_pos >= MAX_OPEN_POSITIONS:
        raise SystemExit(f'guard: max open positions hit ({open_pos} >= {MAX_OPEN_POSITIONS})')
    if recent_loss is not None:
        raise SystemExit(f'guard: cooldown after loss required ({COOLDOWN_AFTER_LOSS}m)')


def price_map():
    data = load_json(ALL_MIDS, {})
    return {str(k).upper(): float(v) for k, v in (data or {}).items() if not str(k).startswith(('#', '@'))}


def asset_set():
    data = load_json(ASSET_CTXS, [])
    out = set()
    blocks = data if isinstance(data, list) else [data]
    for block in blocks:
        if isinstance(block, dict):
            rows = block.get('universe', [])
        elif isinstance(block, list):
            rows = block
        else:
            rows = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = str(row.get('name', '')).upper()
            if name:
                out.add(name)
    return out


def fill_px(asset: str, side: str) -> float:
    mids = price_map()
    base = mids.get(asset.upper(), 100.0)
    return base * (1.001 if side == 'buy' else 0.999)


def main() -> None:
    signals = load_json(SIGNALS, [])
    journal = load_json(JOURNAL, [])
    if not PAPER:
        guards_ok(journal)
    for s in signals:
        asset = str(s.get('market', 'UNKNOWN')).upper()
        side = str(s.get('side', 'buy')).lower()
        if side not in ('buy', 'sell'):
            side = 'buy'
        
        # Override mock execution pricing with real-world mid-price offset
        entry = fill_px(asset, side)
        
        # Take profit mengikuti ROI aktual (unrealized_pnl) dari trader yang di-copy
        # Perkiraan ROI = unrealized_pnl / (actual_entry * actual_size / leverage)
        actual_entry = float(s.get('actual_entry', entry))
        unrealized_pnl = float(s.get('unrealized_pnl', 0))
        actual_size = float(s.get('actual_size', 1))
        leverage = float(s.get('leverage', 1))
        
        position_value = actual_entry * actual_size
        margin_used = position_value / leverage if leverage > 0 else position_value
        
        roi_fraction = (unrealized_pnl / margin_used) if margin_used > 0 else 0.01
        
        # Limit ROI absurd bounds (misal data API error)
        if roi_fraction > 10.0: roi_fraction = 10.0
        if roi_fraction < -1.0: roi_fraction = -1.0
        if roi_fraction == 0: roi_fraction = 0.01

        # Hitung Exit Price berdasarkan estimasi persentase profit target (ROI trader asli)
        if side == 'buy':
            exit_px = entry * (1 + (roi_fraction / leverage))
        else:
            exit_px = entry * (1 - (roi_fraction / leverage))
        size = float(s.get('size', 1))
        # PNL simulation: size * price diff (for shorts, it's entry - exit)
        pnl = (exit_px - entry) * size if side == 'buy' else (entry - exit_px) * size
        journal.append({
            'ts': s.get('ts'),
            'wallet': s.get('wallet'),
            'market': asset,
            'action': s.get('action'),
            'side': side,
            'size': size,
            'entry_px': round(entry, 6),
            'exit_px': round(exit_px, 6),
            'pnl': round(pnl, 6),
            'score': s.get('score'),
            'mode': 'paper' if PAPER else 'live',
            'status': 'closed',
        })
    JOURNAL.write_text(json.dumps(journal, indent=2) + '\n')
    print(json.dumps({'queued': len(signals), 'journal': str(JOURNAL)}, indent=2))


if __name__ == '__main__':
    main()
