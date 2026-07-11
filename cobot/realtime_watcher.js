/**
 * Realtime Hyperliquid Copybot Watcher
 * Subscribe ke semua wallet di scores.json via HL WebSocket.
 * Tiap ada open position baru → langsung execute ke Binance Futures Testnet.
 */

const { SubscriptionClient, WebSocketTransport, MAINNET_API_WS_URL } = require('@nktkas/hyperliquid');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const SCORES_FILE = path.join(ROOT, 'scores.json');
const JOURNAL_FILE = path.join(ROOT, 'trade_journal.json');
const MIDS_FILE = path.join(ROOT, 'all_mids.json');

const MIN_SCORE = parseInt(process.env.COPYBOT_MIN_SCORE || '100');
const ORDER_USDT = parseFloat(process.env.COPYBOT_ORDER_USDT || '50');
const LIVE = process.env.COPYBOT_LIVE === '1';

// Binance Futures Testnet
const API_KEY = process.env.BINANCE_FUTURES_TESTNET_API_KEY || '';
const SECRET   = process.env.BINANCE_FUTURES_TESTNET_SECRET || '';
const BASE_URL = 'https://testnet.binancefuture.com';

const SUPPORTED = new Set([
  'BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX','LINK','DOT',
  'MATIC','LTC','UNI','ATOM','ETC','OP','ARB','APT','NEAR','FIL',
  'INJ','TIA','SUI','PEPE','WIF','BONK','ORDI','STX','MANTA',
]);

const PRECISION = {
  BTC: [3, 0.001], ETH: [3, 0.001], SOL: [1, 0.1],
  BNB: [2, 0.01],  XRP: [0, 1.0],   DOGE: [0, 1.0],
  ADA: [0, 1.0],   AVAX: [1, 0.1],  LINK: [1, 0.1],
};

// Track open positions per wallet: { wallet: { coin: 'long'|'short' } }
const knownPositions = {};

// Our equity cache — refreshed per executeOrder call
let ourEquityUSDT = parseFloat(process.env.COPYBOT_EQUITY || '0');

async function fetchOurEquity() {
  try {
    const data = await bfx('GET', '/fapi/v2/account', {});
    ourEquityUSDT = parseFloat(data.totalMarginBalance || ourEquityUSDT);
  } catch { /* use cached */ }
  return ourEquityUSDT;
}

// ── Direction detection ────────────────────────────────────────────────────────
// fill.dir: "Open Long" | "Open Short" | "Close Long" | "Close Short"
function parseDir(fill) {
  const dir = (fill.dir || '').toLowerCase();
  if (dir.includes('open long'))   return { action: 'open',  side: 'buy'  };
  if (dir.includes('open short'))  return { action: 'open',  side: 'sell' };
  if (dir.includes('close long'))  return { action: 'close', side: 'sell' };
  if (dir.includes('close short')) return { action: 'close', side: 'buy'  };
  // Fallback: infer from fill.side
  return { action: 'open', side: fill.side === 'B' ? 'buy' : 'sell' };
}

// ── Proportional sizing ────────────────────────────────────────────────────────
// Scale our notional proportionally to wallet's equity
// wallet.perpEquity from scores.json; cap at MAX_USDT per trade
const MAX_USDT  = parseFloat(process.env.COPYBOT_MAX_USDT  || '200');
const MIN_USDT  = parseFloat(process.env.COPYBOT_MIN_USDT  || '10');

function calcNotional(fillSz, fillPx, walletEquity, ourEquity) {
  if (!walletEquity || !ourEquity) return parseFloat(process.env.COPYBOT_ORDER_USDT || '50');
  const ratio      = ourEquity / walletEquity;           // e.g. 5000/1000000 = 0.005
  const walletNotional = fillSz * fillPx;                // what wallet traded in USDT
  const scaled     = walletNotional * ratio;
  return Math.min(Math.max(scaled, MIN_USDT), MAX_USDT);
}

// ── Binance helpers ───────────────────────────────────────────────────────────
const crypto = require('crypto');

function sign(params) {
  const ts = Date.now();
  params.timestamp = ts;
  const qs = Object.entries(params).map(([k,v]) => `${k}=${v}`).join('&');
  const sig = crypto.createHmac('sha256', SECRET).update(qs).digest('hex');
  params.signature = sig;
  return params;
}

async function bfx(method, endpoint, params = {}) {
  const signed = sign(params);
  const qs = new URLSearchParams(signed).toString();
  const url = method === 'GET'
    ? `${BASE_URL}${endpoint}?${qs}`
    : `${BASE_URL}${endpoint}`;
  const opts = {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
  };
  if (method === 'POST') opts.body = qs;
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

function getMid(coin) {
  try {
    const mids = JSON.parse(fs.readFileSync(MIDS_FILE, 'utf8'));
    return parseFloat(mids[coin.toUpperCase()] || mids[coin] || 0);
  } catch { return 0; }
}

async function executeOrder(wallet, coin, action, side, score, fillSz, fillPx, walletEquity) {
  const asset = coin.toUpperCase().replace('-USD','').replace('USDT','').split(':').pop();
  if (!SUPPORTED.has(asset)) {
    console.log(`[SKIP] ${asset} not on Binance Futures Testnet`);
    return;
  }

  const sym = `${asset}USDT`;
  const px  = getMid(asset) || fillPx || 100;
  const ourEquity  = await fetchOurEquity();
  const notional   = calcNotional(fillSz, fillPx, walletEquity, ourEquity);
  const [decimals, minQty] = PRECISION[asset] || [2, 0.01];
  const qty = Math.max(parseFloat((notional / px).toFixed(decimals)), minQty);

  // For close: use reduceOnly
  const reduceOnly = action === 'close';

  const record = {
    ts: new Date().toISOString(),
    wallet, market: asset, action, side, score,
    entry_px: px, qty, notional_usdt: notional,
    wallet_equity: walletEquity, our_equity: ourEquity,
    mode: LIVE ? 'live' : 'paper',
    exchange: 'binance_futures_testnet',
  };

  if (!LIVE) {
    console.log(`[PAPER] ${action.toUpperCase()} ${side.toUpperCase()} ${qty} ${sym} @ ~${px} (notional=$${notional.toFixed(1)})`);
    appendJournal(record);
    return;
  }

  try {
    await bfx('POST', '/fapi/v1/leverage', { symbol: sym, leverage: 5 }).catch(() => {});

    const orderParams = {
      symbol: sym,
      side: side === 'buy' ? 'BUY' : 'SELL',
      type: 'MARKET',
      quantity: qty,
    };
    if (reduceOnly) orderParams.reduceOnly = 'true';

    const order = await bfx('POST', '/fapi/v1/order', orderParams);
    record.order_id  = order.orderId;
    record.order_qty = order.origQty;
    console.log(`[EXEC] ✅ ${action.toUpperCase()} ${side.toUpperCase()} ${qty} ${sym} orderId=${order.orderId} notional=$${notional.toFixed(1)}`);
  } catch (e) {
    record.error = e.message;
    console.error(`[EXEC] ❌ ${sym} ${e.message?.slice(0, 120)}`);
  }

  appendJournal(record);
}

function appendJournal(record) {
  let journal = [];
  try { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); } catch {}
  journal.push(record);
  fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2));
}

function loadScores() {
  try {
    return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8'))
      .filter(w => w.score >= MIN_SCORE)
      .map(w => ({ address: w.address, score: w.score, perpEquity: w.perpEquity || 0 }));
  } catch { return []; }
}

// ── WebSocket watcher ─────────────────────────────────────────────────────────
async function main() {
  const wallets = loadScores().slice(0, 10); // Top 10 only — avoid WS flood
  if (!wallets.length) {
    console.error('No wallets in scores.json above MIN_SCORE');
    process.exit(1);
  }

  console.log(`[START] Watching ${wallets.length} wallets | LIVE=${LIVE} | MIN_SCORE=${MIN_SCORE}`);
  console.log(`[MODE] ${LIVE ? '🔴 LIVE → Binance Futures Testnet' : '📄 PAPER only'}`);

  // Single shared transport + client for all subscriptions
  const transport = new WebSocketTransport({ url: MAINNET_API_WS_URL });
  const client = new SubscriptionClient({ transport });

  for (const wallet of wallets) {
    try {
      await client.userFills(
        { user: wallet.address },
        async (event) => {
          if (event?.isSnapshot) return;
          const fills = event?.fills || (Array.isArray(event) ? event : [event]);
          for (const fill of fills) {
            const coin = fill.coin;
            const { action, side } = parseDir(fill);
            const sz   = parseFloat(fill.sz || 0);
            const px   = parseFloat(fill.px || 0);
            console.log(`[FILL] ${wallet.address.slice(0,10)} ${action.toUpperCase()} ${side.toUpperCase()} ${sz} ${coin} @ ${px} (dir: ${fill.dir})`);
            if (sz > 0) await executeOrder(wallet.address, coin, action, side, wallet.score, sz, px, wallet.perpEquity);
          }
        }
      );
      console.log(`[WATCH] ${wallet.address.slice(0,10)}… score=${wallet.score}`);
      await new Promise(r => setTimeout(r, 300)); // stagger to avoid burst
    } catch (e) {
      console.error(`[SUB ERR] ${wallet.address.slice(0,10)}: ${e.message}`);
    }
  }

  console.log('[READY] All wallets subscribed. Listening for fills...');
  // Keep process alive
  await new Promise(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
