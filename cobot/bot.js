const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const WATCH = path.join(ROOT, 'watchlist.json');
const ASSET_CTXS = path.join(ROOT, 'asset_ctxs.json');
const MIDS = path.join(ROOT, 'all_mids.json');
const SCORES = path.join(ROOT, 'scores.json');
const SIGNALS = path.join(ROOT, 'paper_signals.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function scoreWallet(w) {
  const copy = Number(w.copyScore ?? 0);
  const equity = Number(w.perpEquity ?? 0);
  const pnl = Number(w.sumUpnl ?? 0);
  const winrate = Number(w.winrate ?? 0);
  const drawdown = Number(w.drawdown ?? 0);
  const trades = Number(w.totalTrades ?? 0);
  const lev = Number(w.leverage ?? 0);
  const leveragePenalty = lev > 2 ? 30 : lev > 1.5 ? 10 : 0;
  const riskPenalty = (drawdown > 0.35 ? 20 : 0) + (winrate < 0.45 ? 10 : 0) + (trades < 20 ? 10 : 0);
  return Math.round(copy * 3 + Math.log10(Math.max(1, equity)) * 10 + Math.log10(Math.max(1, pnl + 1_000_000)) * 2 - leveragePenalty - riskPenalty);
}

function assetsFromMeta(obj) {
  const set = new Set();
  if (!obj) return set;
  const list = Array.isArray(obj) ? obj.flatMap(x => x?.universe || []) : (obj.universe || []);
  for (const row of list) {
    const name = row?.name;
    if (name) set.add(String(name).toUpperCase());
  }
  return set;
}

// Fetch clearinghouseState to get real-time open positions
function fetchPositions(wallet) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ type: 'clearinghouseState', user: wallet });
    const req = https.request('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed.assetPositions || []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.write(data);
    req.end();
  });
}

async function main() {
  const meta = readJson(ASSET_CTXS, []);
  const allowed = assetsFromMeta(meta);
  const wallets = readJson(WATCH, []);
  
  const scored = wallets.map(w => ({ ...w, score: scoreWallet(w) })).sort((a, b) => b.score - a.score);
  fs.writeFileSync(SCORES, JSON.stringify(scored, null, 2) + '\n');

  const signals = [];
  const topWallets = scored.filter(w => w.score >= 70);
  
  console.log(`Scanning live positions for ${topWallets.length} top wallets...`);

  for (const w of topWallets) {
    const positions = await fetchPositions(w.address);
    
    for (const posObj of positions) {
      const p = posObj.position;
      const szi = parseFloat(p.szi);
      if (szi === 0) continue; // Skip closed positions
      
      const asset = String(p.coin).toUpperCase();
      // Side: positive szi is LONG (buy), negative is SHORT (sell)
      const side = szi > 0 ? 'buy' : 'sell'; 
      
      signals.push({
        wallet: w.address,
        market: asset,
        side: side,
        actual_size: Math.abs(szi),
        actual_entry: parseFloat(p.entryPx),
        unrealized_pnl: parseFloat(p.unrealizedPnl),
        leverage: p.leverage?.value || 1,
        size: Math.max(1, Math.min(10, Math.round(w.score / 10))), // Derived copy size weight
        confidence: Math.min(100, w.score),
        action: 'copy', 
        score: w.score,
        ts: new Date().toISOString(),
      });
    }
    
    // Anti-rate-limit delay (Hyperliquid allows ~1200 req/min)
    await new Promise(r => setTimeout(r, 30));
  }
  
  fs.writeFileSync(SIGNALS, JSON.stringify(signals, null, 2) + '\n');
  
  console.log(JSON.stringify({ 
    watchlist: wallets.length, 
    scored: scored.length, 
    scannedForPositions: topWallets.length,
    activeSignals: signals.length
  }, null, 2));
}

main();