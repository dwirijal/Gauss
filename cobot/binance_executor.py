from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from pathlib import Path

import requests

# ── Config ────────────────────────────────────────────────────────────────────
PAPER            = os.getenv('COPYBOT_LIVE', '0') != '1'
MAX_DAILY_LOSS   = float(os.getenv('COPYBOT_MAX_DAILY_LOSS', '200'))
MAX_OPEN_POS     = int(os.getenv('COPYBOT_MAX_OPEN_POSITIONS', '3'))
COOLDOWN_MIN     = int(os.getenv('COPYBOT_COOLDOWN_AFTER_LOSS_MIN', '30'))
ORDER_USDT       = float(os.getenv('COPYBOT_ORDER_USDT', '50'))   # notional per trade
LEVERAGE         = int(os.getenv('COPYBOT_LEVERAGE', '5'))

API_KEY  = os.getenv('BINANCE_FUTURES_TESTNET_API_KEY', '')
SECRET   = os.getenv('BINANCE_FUTURES_TESTNET_SECRET', '')
BASE_URL = 'https://testnet.binancefuture.com'

ROOT    = Path(__file__).resolve().parent
SIGNALS = ROOT / 'paper_signals.json'
JOURNAL = ROOT / 'trade_journal.json'
ALL_MIDS = ROOT / 'all_mids.json'


# ── Helpers ───────────────────────────────────────────────────────────────────
def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def sign(params: dict) -> dict:
    ts = int(time.time() * 1000)
    params['timestamp'] = ts
    qs = '&'.join(f'{k}={v}' for k, v in params.items())
    sig = hmac.new(SECRET.encode(), qs.encode(), hashlib.sha256).hexdigest()
    params['signature'] = sig
    return params


def bfx(method: str, path: str, params: dict = None):
    """Raw signed request to Binance Futures Testnet."""
    params = sign(params or {})
    headers = {'X-MBX-APIKEY': API_KEY}
    url = BASE_URL + path
    r = requests.request(method, url, params=params, headers=headers, timeout=10)
    r.raise_for_status()
    return r.json()


def price_map() -> dict:
    data = load_json(ALL_MIDS, {})
    return {str(k).upper(): float(v) for k, v in (data or {}).items()
            if not str(k).startswith(('#', '@'))}


def fill_px(asset: str, side: str) -> float:
    mids = price_map()
    base = mids.get(asset.upper(), 100.0)
    return base * (1.001 if side == 'buy' else 0.999)


def guards_ok(journal: list):
    total_pnl = sum(float(t.get('pnl', 0) or 0) for t in journal)
    open_pos  = sum(1 for t in journal if t.get('status') == 'open')
    recent_loss = next((t for t in reversed(journal)
                        if float(t.get('pnl', 0) or 0) < 0), None)
    if total_pnl <= -MAX_DAILY_LOSS:
        raise SystemExit(f'guard: max daily loss ({total_pnl:.2f})')
    if open_pos >= MAX_OPEN_POS:
        raise SystemExit(f'guard: max open positions ({open_pos})')
    if recent_loss:
        raise SystemExit(f'guard: cooldown after loss ({COOLDOWN_MIN}m)')


# Pairs available on Binance Futures Testnet
SUPPORTED_SYMBOLS = {
    'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT',
    'MATIC', 'LTC', 'UNI', 'ATOM', 'ETC', 'OP', 'ARB', 'APT', 'NEAR', 'FIL',
    'INJ', 'TIA', 'SUI', 'PEPE', 'WIF', 'BONK', 'ORDI', 'STX', 'MANTA',
}

def symbol_for(asset: str) -> str | None:
    """Convert asset name to Binance USDT-M perp symbol. Returns None if unsupported."""
    asset = asset.upper().replace('-USD', '').replace('/USDT', '').replace('USDT', '')
    if asset not in SUPPORTED_SYMBOLS:
        return None
    return f'{asset}USDT'


def place_order(asset: str, side: str, usdt_notional: float) -> dict:
    """Place market order on Binance Futures Testnet. Returns order response."""
    sym = symbol_for(asset)

    # Set leverage first
    try:
        bfx('POST', '/fapi/v1/leverage', {'symbol': sym, 'leverage': LEVERAGE})
    except Exception:
        pass  # symbol may not support custom leverage

    # Get current price for qty calc
    mids = price_map()
    px = mids.get(asset.upper(), 100.0)
    raw_qty = usdt_notional / px

    # Per-asset min qty & precision rules for Binance Futures Testnet
    PRECISION = {
        'BTC': (3, 0.001), 'ETH': (3, 0.001), 'SOL': (1, 0.1),
        'BNB': (2, 0.01),  'XRP': (0, 1.0),   'DOGE': (0, 1.0),
        'ADA': (0, 1.0),   'AVAX': (1, 0.1),  'LINK': (1, 0.1),
    }
    decimals, min_qty = PRECISION.get(asset.upper(), (2, 0.01))
    qty = round(raw_qty, decimals)
    qty = max(qty, min_qty)

    params = {
        'symbol':   sym,
        'side':     'BUY' if side == 'buy' else 'SELL',
        'type':     'MARKET',
        'quantity': qty,
    }
    return bfx('POST', '/fapi/v1/order', params)


# ── Main ──────────────────────────────────────────────────────────────────────
def main() -> None:
    signals = load_json(SIGNALS, [])
    # Limit to first 5 signals per run to avoid timeout/rate limits
    MAX_PER_RUN = int(os.getenv('COPYBOT_MAX_PER_RUN', '5'))
    signals = signals[:MAX_PER_RUN]
    journal = load_json(JOURNAL, [])

    if not PAPER:
        guards_ok(journal)

    results = {'queued': len(signals), 'paper': PAPER, 'executed': 0, 'errors': 0}

    for s in signals:
        asset = str(s.get('market', 'UNKNOWN')).upper()
        side  = str(s.get('side', 'buy')).lower()
        if side not in ('buy', 'sell'):
            side = 'buy'

        entry = fill_px(asset, side)

        # ROI estimation from copied trader
        actual_entry    = float(s.get('actual_entry', entry))
        unrealized_pnl  = float(s.get('unrealized_pnl', 0))
        actual_size     = float(s.get('actual_size', 1))
        leverage        = float(s.get('leverage', 1))
        position_value  = actual_entry * actual_size
        margin_used     = position_value / leverage if leverage > 0 else position_value
        roi_fraction    = (unrealized_pnl / margin_used) if margin_used > 0 else 0.01
        roi_fraction    = max(-1.0, min(10.0, roi_fraction)) or 0.01

        if side == 'buy':
            exit_px = entry * (1 + roi_fraction / leverage)
        else:
            exit_px = entry * (1 - roi_fraction / leverage)

        size = float(s.get('size', 1))
        pnl  = (exit_px - entry) * size if side == 'buy' else (entry - exit_px) * size

        record = {
            'ts':       s.get('ts'),
            'wallet':   s.get('wallet'),
            'market':   asset,
            'action':   s.get('action'),
            'side':     side,
            'size':     size,
            'entry_px': round(entry, 6),
            'exit_px':  round(exit_px, 6),
            'pnl':      round(pnl, 6),
            'score':    s.get('score'),
            'mode':     'paper' if PAPER else 'live',
            'status':   'closed',
            'exchange': 'binance_futures_testnet',
        }

        if not PAPER:
            sym = symbol_for(asset)
            if sym is None:
                record['error'] = f'unsupported symbol on testnet: {asset}'
                results['errors'] += 1
                journal.append(record)
                continue
            try:
                order = place_order(asset, side, ORDER_USDT)
                record['order_id']  = order.get('orderId')
                record['order_qty'] = order.get('origQty')
                record['status']    = 'open'
                results['executed'] += 1
            except Exception as e:
                record['error'] = str(e)
                results['errors'] += 1

        journal.append(record)

    JOURNAL.write_text(json.dumps(journal, indent=2) + '\n')
    results['journal'] = str(JOURNAL)
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
