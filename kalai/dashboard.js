// KalAI live dashboard — zero-dep Node http server
const http = require('http');
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');
const crypto = require('crypto');

const PORT = 3777;
const env = {};
let COBOT_KEY = '';
let COBOT_SEC = '';

for (const line of fs.readFileSync(process.env.HOME + '/.hermes/.env', 'utf8').split('\n')) {
  const t = line.trim();
  if (t.startsWith('BINANCE_DEMO2_')) { 
    const i = t.indexOf('='); 
    env[t.slice(0, i)] = t.slice(i + 1); 
  }
  if (t.startsWith('BINANCE_FUTURES_TESTNET_API_KEY=')) COBOT_KEY = t.split('=')[1];
  if (t.startsWith('BINANCE_FUTURES_TESTNET_SECRET=')) COBOT_SEC = t.split('=')[1];
}

const KEY = env.BINANCE_DEMO2_API_KEY, SEC = env.BINANCE_DEMO2_SECRET;
const BASE = 'https://testnet.binancefuture.com';
const mk = q => { const ts = Date.now(); const qs = (q ? q + '&' : '') + 'timestamp=' + ts + '&recvWindow=5000'; return qs + '&signature=' + crypto.createHmac('sha256', SEC).update(qs).digest('hex'); };
const HDR = { 'X-MBX-APIKEY': KEY };

let baseBalances = {
  kalai: { bal: 0, lastFetch: 0 },
  cobot: { bal: 0, lastFetch: 0 }
};

function getJSON(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: HDR }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function getCobotSnapshot() {
  if (!COBOT_KEY || !COBOT_SEC) return { bal: 0, upnl: 0 };
  const mkCobot = q => { 
    const ts = Date.now(); 
    const qs = (q ? q + '&' : '') + 'timestamp=' + ts + '&recvWindow=5000'; 
    return qs + '&signature=' + crypto.createHmac('sha256', COBOT_SEC).update(qs).digest('hex'); 
  };
  const HDR_COBOT = { 'X-MBX-APIKEY': COBOT_KEY };
  
  return new Promise((resolve) => {
    https.get(`${BASE}/fapi/v2/account?${mkCobot('')}`, { headers: HDR_COBOT }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { 
        try { 
          const data = JSON.parse(d);
          const bal = +(data.totalMarginBalance || data.totalWalletBalance || 0);
          const upnl = +(data.totalUnrealizedProfit || 0);
          resolve({ bal, upnl });
        } catch { 
          resolve({ bal: 0, upnl: 0 }); 
        } 
      });
    }).on('error', () => resolve({ bal: 0, upnl: 0 }));
  });
}

async function getCobotPositions() {
  if (!COBOT_KEY || !COBOT_SEC) return [];
  const mkCobot = q => { 
    const ts = Date.now(); 
    const qs = (q ? q + '&' : '') + 'timestamp=' + ts + '&recvWindow=5000'; 
    return qs + '&signature=' + crypto.createHmac('sha256', COBOT_SEC).update(qs).digest('hex'); 
  };
  const HDR_COBOT = { 'X-MBX-APIKEY': COBOT_KEY };
  
  return new Promise((resolve) => {
    https.get(`${BASE}/fapi/v2/positionRisk?${mkCobot('')}`, { headers: HDR_COBOT }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { 
        try { 
          const data = JSON.parse(d);
          const pos = (data || []).filter(p => Math.abs(parseFloat(p.positionAmt)) > 0.0001)
            .map(p => ({
              symbol: p.symbol,
              size: Math.abs(parseFloat(p.positionAmt)),
              side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
              entry: parseFloat(p.entryPrice),
              upnl: parseFloat(p.unRealizedProfit)
            }));
          resolve(pos);
        } catch { 
          resolve([]); 
        } 
      });
    }).on('error', () => resolve([]));
  });
}

async function fetchBaseBalances() {
  const now = Date.now();
  // Fetch KalAI (1 min interval to keep fresh)
  if (now - baseBalances.kalai.lastFetch > 60000) {
    try {
      const acct = await getJSON(`${BASE}/fapi/v2/account?${mk('')}`);
      if (acct) {
        baseBalances.kalai.bal = +(acct.totalWalletBalance || acct.totalMarginBalance || 0);
        baseBalances.kalai.lastFetch = now;
      }
    } catch {}
  }
  // Fetch Cobot (1 min interval)
  if (now - baseBalances.cobot.lastFetch > 60000) {
    try {
      const snap = await getCobotSnapshot();
      if (snap) {
        baseBalances.cobot.bal = snap.bal;
        baseBalances.cobot.lastFetch = now;
      }
    } catch {}
  }
}

async function botsData() {
  const fs = require('fs');
  const out = {};
  await fetchBaseBalances();
  
  // KalAI
  try {
    const st = JSON.parse(fs.readFileSync(__dirname + '/state.json', 'utf8'));
    out.kalai = { name: 'KalAI', type: 'Crypto TA Bot', symbols: Object.keys(st).length, live: true, state: st };
  } catch { out.kalai = { name: 'KalAI', error: 'no state' }; }
  
  // Meridian
  try {
    const d = JSON.parse(fs.readFileSync('/home/dwizzy/dwizzyOS/gauss/meridian/decision-log.json', 'utf8'));
    const dec = d.decisions || [];
    const last = dec[dec.length - 1] || {};
    const types = {};
    for (const x of dec) types[x.type] = (types[x.type] || 0) + 1;
    out.meridian = { 
      name: 'Meridian', 
      type: 'Solana DLMM LP Agent', 
      decisions: dec.length, 
      last_type: last.type, 
      last_summary: last.summary, 
      types,
      history: dec.slice(-20).reverse()
    };
  } catch (e) { out.meridian = { name: 'Meridian', error: e.message }; }
  
  // Cobot
  try {
    const j = JSON.parse(fs.readFileSync('/home/dwizzy/dwizzyOS/gauss/cobot/trade_journal.backup.json', 'utf8'));
    const last = j[0] || {};
    const cPos = await getCobotPositions();
    
    let watchlist = [];
    try {
      const wl = JSON.parse(fs.readFileSync('/home/dwizzy/dwizzyOS/gauss/cobot/watchlist.json', 'utf8'));
      watchlist = wl.slice(0, 50).map(w => ({
        address: w.address,
        name: w.displayName,
        score: Math.round(w.copyScore),
        winrate: Math.round(w.winrate)
      }));
    } catch {}

    let active = [];
    try {
      const sigs = JSON.parse(fs.readFileSync('/home/dwizzy/dwizzyOS/gauss/cobot/paper_signals.json', 'utf8'));
      active = sigs.slice(0, 50).map(s => ({
        wallet: s.wallet,
        market: s.market,
        side: (s.side || '').toUpperCase(),
        upnl: s.unrealized_pnl,
        entry: s.actual_entry || 0
      }));
    } catch {}

    let history = [];
    try {
      const jr = JSON.parse(fs.readFileSync('/home/dwizzy/dwizzyOS/gauss/cobot/trade_journal.json', 'utf8'));
      history = jr.slice(-50).map(h => ({
        ts: h.ts,
        market: h.market,
        side: (h.side || '').toUpperCase(),
        pnl: h.pnl,
        status: h.status,
        entry: h.entry_px || 0,
        exit: h.exit_px || 0,
        wallet: h.wallet || ''
      })).reverse();
    } catch {}

    out.cobot = {
      name: 'Cobot',
      type: 'Copy Trading Bot',
      trades: j.length,
      last_action: last.action,
      last_mode: last.mode,
      last_score: last.score,
      base_balance: baseBalances.cobot.bal,
      positions: cPos,
      watchlist,
      active_positions: active,
      history
    };
  } catch (e) { out.cobot = { name: 'Cobot', error: e.message }; }
  
  return out;
}

async function snapshot() {
  await fetchBaseBalances();
  
  let kalaiPosMap = {};
  try {
    const kPath = path.join(__dirname, 'kalai_positions.json');
    if (fs.existsSync(kPath)) {
      kalaiPosMap = JSON.parse(fs.readFileSync(kPath, 'utf8') || '{}');
    }
  } catch (e) {
    console.error('Err read kalai_positions.json', e.message);
  }

  const pr = await getJSON(`${BASE}/fapi/v2/positionRisk?${mk('')}`);
  const pos = (pr || []).filter(p => Math.abs(parseFloat(p.positionAmt)) > 0.0001)
    .map(p => {
      const dbg = kalaiPosMap[p.symbol] || {};
      return {
        s: p.symbol,
        a: Math.abs(parseFloat(p.positionAmt)),
        upnl: parseFloat(p.unRealizedProfit),
        entry: dbg.entry || parseFloat(p.entryPrice),
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        tp: dbg.tp || null,
        sl: dbg.sl || null,
        ts: dbg.ts || null
      };
    });

  let pm2 = [];
  try { pm2 = JSON.parse(execSync('pm2 jlist 2>/dev/null').toString() || '[]'); } catch {}
  
  const modes = ['kalai-scalping', 'kalai-intraday', 'kalai-swing', 'meridian'].map(n => {
    const p = pm2.find(x => x.name === n);
    const dispName = n === 'meridian' ? 'Meridian Agent' : n.replace('kalai-', '');
    return { name: dispName, status: p ? p.pm2_env.status : 'off', uptime: p ? Math.round(p.pm_uptime / 1000) : 0 };
  });
  
  let errs = 0;
  try { errs = parseInt(execSync("grep -c '' ~/.pm2/logs/kalai-{scalping,intraday,swing}-error.log 2>/dev/null | awk -F: '{s+=$2} END{print s}'").toString()) || 0; } catch {}
  let recent = [];
  try { recent = execSync("grep -h 'EXEC\\|SIGNAL' ~/.pm2/logs/kalai-*.out.log 2>/dev/null | tail -5").toString().trim().split('\n').filter(Boolean); } catch {}
  return { base_balance: baseBalances.kalai.bal, pos, modes, errs, recent, ts: new Date().toISOString() };
}

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gauss Terminal</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script>
  window.onerror = function(msg, url, line, col, error) {
    var errDiv = document.createElement('div');
    errDiv.style = "color:#ff5470;padding:20px;background:#0f1011;border:1px solid #ff5470;z-index:9999;position:fixed;top:10px;left:10px;right:10px;font-family:monospace;font-size:12px;border-radius:8px;";
    errDiv.innerHTML = "<h4>FATAL FRONTEND ERROR:</h4>" + msg + "<br><br>Line: " + line + ":" + col + "<br>Stack: " + (error ? error.stack : 'N/A');
    document.body.appendChild(errDiv);
    window.__lastError = msg + " at line " + line + ":" + col;
  };
</script>
<style>
:root {
  --bg-dark: #050607;
  --bg-panel: #0b0c0e;
  --bg-surface: #121316;
  --text-primary: #f0f2f5;
  --text-secondary: #7a828e;
  --text-quaternary: #4a505a;
  --border-subtle: rgba(255,255,255,0.04);
  --border-card: rgba(255,255,255,0.06);
  --accent-violet: #8c8aff;
  --accent-indigo: #6d76ff;
  --pos-green: #00e676;
  --pos-green-bg: rgba(0,230,118,0.08);
  --neg-red: #ff3d60;
  --neg-red-bg: rgba(255,61,96,0.08);
  --warn-orange: #ff9100;
  --warn-orange-bg: rgba(255,145,0,0.08);
}
* { margin:0; padding:0; box-sizing:border-box; }
body { 
  background: var(--bg-dark); 
  color: var(--text-primary); 
  font-family: 'Inter', -apple-system, sans-serif; 
  padding: 16px; 
  max-width: 800px; 
  margin: 0 auto; 
  line-height: 1.4;
}
header { 
  margin-bottom: 24px; 
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: 14px;
}
h1 { 
  font-size: 22px; 
  font-weight: 600; 
  color: var(--text-primary); 
  display: flex; 
  align-items: center; 
  gap: 8px; 
  letter-spacing: -0.5px;
}
.ts { 
  color: var(--text-secondary); 
  font-size: 11px; 
  margin-top: 4px;
  font-family: 'JetBrains Mono', monospace;
}

/* Tabs system */
.nav-tabs { 
  display: flex; 
  gap: 6px; 
  background: var(--bg-panel);
  padding: 4px; 
  border-radius: 8px;
  border: 1px solid var(--border-card);
  margin-bottom: 20px; 
}
.tab-btn { 
  flex: 1;
  background: transparent; 
  border: none; 
  color: var(--text-secondary); 
  font-size: 13px; 
  font-weight: 500; 
  padding: 8px 12px; 
  border-radius: 6px; 
  cursor: pointer; 
  transition: all 0.15s ease;
  text-align: center;
}
.tab-btn:hover { 
  color: var(--text-primary); 
  background: rgba(255,255,255,0.02); 
}
.tab-btn.active { 
  color: var(--text-primary); 
  background: var(--bg-surface); 
  box-shadow: 0 1px 3px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05); 
  border: 1px solid rgba(255,255,255,0.02);
}
.tab-content { display: none; }
.tab-content.active { display: block; }

/* Cobot Sub-tabs system */
.sub-tabs { 
  display: flex; 
  gap: 4px; 
  background: rgba(255,255,255,0.01);
  padding: 3px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle);
  margin-bottom: 16px; 
}
.sub-tab-btn { 
  flex: 1;
  background: transparent; 
  border: none;
  color: var(--text-secondary); 
  font-size: 11px; 
  font-weight: 500; 
  padding: 6px 8px; 
  border-radius: 4px; 
  cursor: pointer; 
  transition: all 0.15s ease;
  text-align: center;
}
.sub-tab-btn:hover { 
  color: var(--text-primary); 
}
.sub-tab-btn.active { 
  color: var(--text-primary); 
  background: var(--bg-panel); 
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
}
.sub-tab-content { display: none; }
.sub-tab-content.active { display: block; }

/* Card components */
.card { 
  background: var(--bg-panel); 
  border: 1px solid var(--border-card); 
  border-radius: 12px; 
  padding: 16px; 
  margin-bottom: 16px; 
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.card-header { 
  font-size: 11px; 
  font-weight: 600; 
  text-transform: uppercase; 
  letter-spacing: 1px; 
  margin-bottom: 12px; 
  display: flex; 
  justify-content: space-between; 
  align-items: center; 
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: 6px;
  color: var(--text-secondary);
}
.row { 
  display: flex; 
  justify-content: space-between; 
  align-items: center; 
  padding: 8px 0; 
  border-bottom: 1px solid var(--border-subtle); 
}
.row:last-child { border-bottom: none; }
.label { color: var(--text-secondary); font-size: 12px; }
.val { 
  font-size: 13.5px; 
  font-weight: 500; 
  font-family: 'JetBrains Mono', monospace;
}
.pos { color: var(--pos-green); } 
.neg { color: var(--neg-red); }

.pill { 
  padding: 2px 6px; 
  border-radius: 4px; 
  font-size: 9px; 
  font-weight: 600; 
  text-transform: uppercase; 
  font-family: 'Inter', sans-serif;
  letter-spacing: 0.5px;
}
.online { 
  background: var(--pos-green-bg); 
  color: var(--pos-green); 
  border: 1px solid rgba(0,230,118,0.15);
  position: relative;
  padding-left: 14px;
}
.online::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 4px;
  background: var(--pos-green);
  border-radius: 50%;
  box-shadow: 0 0 6px var(--pos-green);
  animation: pulse 1.5s infinite;
}
.off { 
  background: var(--neg-red-bg); 
  color: var(--neg-red); 
  border: 1px solid rgba(255,61,96,0.15);
  position: relative;
  padding-left: 14px;
}
.off::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 50%;
  transform: translateY(-50%);
  width: 4px;
  height: 4px;
  background: var(--neg-red);
  border-radius: 50%;
}
.mono { 
  font-family: 'JetBrains Mono', monospace; 
  font-size: 11px; 
}

/* Scroll lists */
.scroll-list { 
  max-height: 380px; 
  overflow-y: auto; 
  padding-right: 4px; 
  margin-top: 4px; 
}
::-webkit-scrollbar { width: 3px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 2px; }

/* Grid columns for tabular views */
.grid-header { 
  display: grid; 
  grid-template-columns: 2fr 1fr 1.2fr; 
  font-size: 10px; 
  font-weight: 600; 
  text-transform: uppercase; 
  color: var(--text-secondary); 
  border-bottom: 1px solid var(--border-subtle); 
  padding-bottom: 6px; 
  margin-top: 4px; 
}
.grid-row { 
  display: grid; 
  grid-template-columns: 2fr 1fr 1.2fr; 
  font-size: 11.5px; 
  padding: 8px 0; 
  border-bottom: 1px solid var(--border-subtle); 
  align-items: center; 
}
.grid-row:last-child { border-bottom: none; }

/* For 4 column views */
.grid4-header { 
  display: grid; 
  grid-template-columns: 1.5fr 1fr 1fr 1.2fr; 
  font-size: 10px; 
  font-weight: 600; 
  text-transform: uppercase; 
  color: var(--text-secondary); 
  border-bottom: 1px solid var(--border-subtle); 
  padding-bottom: 6px; 
  margin-top: 4px; 
}
.grid4-row { 
  display: grid; 
  grid-template-columns: 1.5fr 1fr 1fr 1.2fr; 
  font-size: 11.5px; 
  padding: 8px 0; 
  border-bottom: 1px solid var(--border-subtle); 
  align-items: center; 
}
.grid4-row:last-child { border-bottom: none; }

/* Anchor links */
a.wallet-link { 
  color: var(--accent-violet); 
  text-decoration: none; 
  border-bottom: 1px dashed rgba(140, 138, 255, 0.4); 
  cursor: pointer; 
  transition: all 0.15s ease;
}
a.wallet-link:hover { 
  color: #a3a1ff; 
  border-bottom-color: #a3a1ff; 
}
.filter-active { 
  color: var(--warn-orange) !important; 
  border-bottom-color: var(--warn-orange) !important; 
  font-weight: 600; 
}
.filter-banner { 
  background: var(--warn-orange-bg); 
  border: 1px solid rgba(255,145,0,0.15); 
  border-radius: 8px; 
  padding: 8px 12px; 
  margin-bottom: 12px; 
  font-size: 12px; 
  display: flex; 
  justify-content: space-between; 
  align-items: center; 
}
.clear-filter-btn { 
  background: var(--warn-orange); 
  color: #050607; 
  border: none; 
  padding: 4px 8px; 
  border-radius: 4px; 
  font-size: 10px; 
  font-weight: 600; 
  cursor: pointer; 
  transition: opacity 0.15s ease;
}
.clear-filter-btn:hover {
  opacity: 0.9;
}

.position-card {
  transition: background 0.15s ease;
}
.position-card:hover {
  background: rgba(255,255,255,0.01);
}

.dex-card {
  background: rgba(255,255,255,0.015);
  border: 1px dashed rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 10px;
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dex-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
}
.dex-stats {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-secondary);
}
.dex-link {
  color: var(--accent-violet);
  text-decoration: none;
  font-size: 10.5px;
  font-weight: 500;
  border-bottom: 1px dashed var(--accent-violet);
}

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(0,230,118,0.4); }
  70% { box-shadow: 0 0 0 6px rgba(0,230,118,0); }
  100% { box-shadow: 0 0 0 0 rgba(0,230,118,0); }
}
</style></head>
<body>
<header>
  <h1>⚡ Gauss Terminal</h1>
  <div class="ts" id="ts">Loading terminal status...</div>
</header>

<div class="nav-tabs">
  <button class="tab-btn active" onclick="openTab('tab-kalai', event)">KalAI (Futures)</button>
  <button class="tab-btn" onclick="openTab('tab-cobot', event)">Cobot (Copy HL)</button>
  <button class="tab-btn" onclick="openTab('tab-meridian', event)">Meridian (DLMM)</button>
  <button class="tab-btn" onclick="openTab('tab-trenchess', event)">Trenchess (Degen)</button>
</div>

<!-- ================= KALAI TAB ================= -->
<div id="tab-kalai" class="tab-content active">
  <div class="card">
    <div class="card-header"><span style="color: var(--accent-violet);">Binance Testnet Account</span></div>
    <div class="row"><span class="label">Equity Balance</span><span class="val" id="bal">$-.--</span></div>
    <div class="row"><span class="label">Unrealized PnL</span><span class="val" id="upnl">$-.--</span></div>
    <div class="row"><span class="label">Errors (24h)</span><span class="val" id="errs">-</span></div>
  </div>
  
  <div class="card">
    <div class="card-header"><span style="color: var(--accent-violet);">Execution Modes & Daemons</span></div>
    <div id="modes"></div>
  </div>
  
  <div class="card">
    <div class="card-header"><span style="color: var(--accent-violet);">Open Positions</span><span class="pill mono" id="poscount" style="background: rgba(255,255,255,0.05); color: var(--text-primary);">0</span></div>
    <div id="positions"></div>
  </div>
  
  <div class="card">
    <div class="card-header"><span style="color: var(--accent-violet);">Recent Execution Signals</span></div>
    <div id="recent" class="mono"></div>
  </div>
</div>

<!-- ================= COBOT TAB ================= -->
<div id="tab-cobot" class="tab-content">
  <div class="card">
    <div class="card-header"><span style="color: var(--warn-orange);">Cobot Copy Trading Status</span></div>
    <div class="row"><span class="label">Binance Testnet Balance (Client)</span><span class="val" id="cobot-balance">$-.--</span></div>
    <div class="row"><span class="label">Unrealized PnL (Client)</span><span class="val" id="cobot-upnl">$-.--</span></div>
    <div class="row"><span class="label">Historical Trades</span><span class="val" id="cobot-trades">-</span></div>
    <div class="row"><span class="label">Last Action Details</span><span class="val" id="cobot-last">-</span></div>
  </div>

  <div class="sub-tabs">
    <button class="sub-tab-btn active" onclick="openSubTab('cobot-tab-wl', event)">Wallet List</button>
    <button class="sub-tab-btn" onclick="openSubTab('cobot-tab-active', event)">Active Trades</button>
    <button class="sub-tab-btn" onclick="openSubTab('cobot-tab-hist', event)">Recent Trades</button>
  </div>

  <!-- Filter Banner -->
  <div id="filter-banner" class="filter-banner" style="display: none;">
    <span>Filtering data by master wallet: <b id="filtered-wallet-name" class="mono"></b></span>
    <button class="clear-filter-btn" onclick="clearWalletFilter()">Clear Filter</button>
  </div>

  <!-- Subtab 1: Wallet List -->
  <div id="cobot-tab-wl" class="sub-tab-content active card">
    <div class="card-header"><span style="color: var(--warn-orange);">Watchlist (Click to Filter Trades locally)</span></div>
    <div class="grid-header">
      <span>Master Wallet</span>
      <span>Score</span>
      <span>Winrate</span>
    </div>
    <div class="scroll-list" id="cobot-wl"></div>
  </div>

  <!-- Subtab 2: Active Trades -->
  <div id="cobot-tab-active" class="sub-tab-content">
    <!-- CLIENT POSITIONS -->
    <div class="card">
      <div class="card-header"><span style="color: var(--pos-green);">Your Live Positions (Client Account)</span></div>
      <div class="grid-header" style="grid-template-columns: 1.5fr 1fr 1fr;">
        <span>Symbol / Side</span>
        <span>Entry Price</span>
        <span>Unrealized PnL</span>
      </div>
      <div class="scroll-list" id="cobot-your-active" style="max-height: 180px;"></div>
    </div>
    
    <!-- MASTER TARGET POSITIONS -->
    <div class="card">
      <div class="card-header"><span style="color: var(--warn-orange);">Master Positions (Target Watchlist)</span></div>
      <div class="grid4-header">
        <span>Market / Side</span>
        <span>Entry Price</span>
        <span>Current PnL</span>
        <span>Master Wallet</span>
      </div>
      <div class="scroll-list" id="cobot-master-active" style="max-height: 250px;"></div>
    </div>
  </div>

  <!-- Subtab 3: Recent Trades -->
  <div id="cobot-tab-hist" class="sub-tab-content card">
    <div class="card-header"><span style="color: var(--warn-orange);">Copy Trades History</span></div>
    <div class="grid4-header">
      <span>Market / Side</span>
      <span>Entry / Exit</span>
      <span>Realized PnL</span>
      <span>Status</span>
    </div>
    <div class="scroll-list" id="cobot-hist"></div>
  </div>
</div>

<!-- ================= MERIDIAN TAB ================= -->
<div id="tab-meridian" class="tab-content">
  <div class="card">
    <div class="card-header"><span style="color: var(--pos-green);">Meridian Status</span></div>
    <div class="row"><span class="label">Total Decisions</span><span class="val" id="meridian-decisions">-</span></div>
    <div class="row"><span class="label">Last Execution Type</span><span class="val" id="meridian-last-type">-</span></div>
    <div class="row"><span class="label">Last Decision Details</span><span class="val" id="meridian-last-summary" style="font-size:11px; color: var(--text-secondary); text-align:right;">-</span></div>
  </div>

  <div class="card">
    <div class="card-header"><span style="color: var(--pos-green);">Decision Profile Stats</span></div>
    <div id="meridian-stats"></div>
  </div>

  <div class="card">
    <div class="card-header"><span style="color: var(--pos-green);">Decisions History</span></div>
    <div class="grid-header">
      <span>Time</span>
      <span>Decision Type</span>
      <span>Summary</span>
    </div>
    <div class="scroll-list" id="meridian-history" style="max-height: 350px;"></div>
  </div>
</div>

<!-- ================= TRENCHESS TAB ================= -->
<div id="tab-trenchess" class="tab-content">
  <div class="card">
    <div class="card-header"><span style="color: var(--warn-orange);">Trenchess Discord Signals (Degen)</span></div>
    <div class="scroll-list" id="trenchess-list" style="max-height: 600px;">
      <div class="row"><span class="label">Loading signals...</span></div>
    </div>
  </div>
</div>

<script>
let lastCobotData = null;
let lastKalaiData = null;
let activeFilterWallet = null;
let livePrices = {};

// Safely convert and format to fixed decimal places
function formatFixed(val, decimals) {
  const parsed = parseFloat(val);
  return isNaN(parsed) ? '-' : parsed.toFixed(decimals);
}

function formatAge(ts) {
  if (!ts) return '-';
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return secs + 's ago';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ' + (secs % 60) + 's ago';
  const hrs = Math.floor(mins / 60);
  return hrs + 'h ' + (mins % 60) + 'm ago';
}

function openTab(tabId, evt) {
  const contents = document.getElementsByClassName('tab-content');
  for (let i = 0; i < contents.length; i++) {
    contents[i].classList.remove('active');
  }
  const btns = document.getElementsByClassName('tab-btn');
  for (let i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }
  document.getElementById(tabId).classList.add('active');
  if (evt && evt.currentTarget) {
    evt.currentTarget.classList.add('active');
  }
}

function openSubTab(subTabId, evt) {
  const contents = document.getElementsByClassName('sub-tab-content');
  for (let i = 0; i < contents.length; i++) {
    contents[i].classList.remove('active');
  }
  const btns = document.getElementsByClassName('sub-tab-btn');
  for (let i = 0; i < btns.length; i++) {
    btns[i].classList.remove('active');
  }
  document.getElementById(subTabId).classList.add('active');
  if (evt && evt.currentTarget) {
    evt.currentTarget.classList.add('active');
  }
}

function filterWallet(address) {
  activeFilterWallet = (activeFilterWallet === address) ? null : address;
  renderCobotLists();
}

function clearWalletFilter() {
  activeFilterWallet = null;
  renderCobotLists();
}

// Calculate client positions uPnL & total live balance
function calcLiveStats() {
  let cobotUpnl = 0;
  
  if (lastCobotData && lastCobotData.positions) {
    lastCobotData.positions.forEach(p => {
      const symbol = p.symbol;
      const currentPrice = livePrices[symbol] || livePrices[symbol + 'USDT'] || p.entry;
      const diff = currentPrice - p.entry;
      const posAmt = p.side === 'LONG' ? p.size : -p.size;
      const u = diff * posAmt;
      p.upnl = u;
      cobotUpnl += u;
    });
    
    const liveBal = (lastCobotData.base_balance || 0) + cobotUpnl;
    document.getElementById('cobot-balance').textContent = '$' + formatFixed(liveBal, 2);
    
    const cu = document.getElementById('cobot-upnl');
    cu.textContent = (cobotUpnl >= 0 ? '+$' : '-$') + Math.abs(cobotUpnl).toFixed(2);
    cu.className = 'val ' + (cobotUpnl >= 0 ? 'pos' : 'neg');
  }

  if (lastKalaiData && lastKalaiData.pos) {
    let kalaiUpnl = 0;
    lastKalaiData.pos.forEach(p => {
      const currentPrice = livePrices[p.s] || p.entry;
      const diff = currentPrice - p.entry;
      const u = diff * p.a;
      p.upnl = u;
      kalaiUpnl += u;
    });

    const liveBal = (lastKalaiData.base_balance || 0) + kalaiUpnl;
    document.getElementById('bal').textContent = '$' + formatFixed(liveBal, 2);
    
    const u = document.getElementById('upnl');
    u.textContent = (kalaiUpnl >= 0 ? '+$' : '-$') + Math.abs(kalaiUpnl).toFixed(2);
    u.className = 'val ' + (kalaiUpnl >= 0 ? 'pos' : 'neg');
  }
}

function renderCobotLists() {
  if (!lastCobotData) return;
  const cb = lastCobotData;

  const banner = document.getElementById('filter-banner');
  if (activeFilterWallet) {
    banner.style.display = 'flex';
    document.getElementById('filtered-wallet-name').textContent = activeFilterWallet.slice(0, 12) + '...';
  } else {
    banner.style.display = 'none';
  }

  // Render Watchlist (clickable filter)
  document.getElementById('cobot-wl').innerHTML = (cb.watchlist || []).map(w => {
    const isFiltered = activeFilterWallet === w.address;
    return '<div class="grid-row">' +
      '<span><a class="wallet-link mono ' + (isFiltered ? 'filter-active' : '') + '" onclick="filterWallet(\\\'' + w.address + '\\\')">' + (w.name || w.address.slice(0,10)+'...') + '</a></span>' +
      '<span>Score: <b>' + w.score + '</b></span>' +
      '<span>WR: <b>' + w.winrate + '%</b></span>' +
    '</div>';
  }).join('') || '<div class="row"><span class="label">none</span></div>';

  // Render Client positions (YOUR Positions - not affected by filter)
  document.getElementById('cobot-your-active').innerHTML = (cb.positions || []).map(p => {
    const color = p.upnl >= 0 ? 'pos' : 'neg';
    const sign = p.upnl >= 0 ? '+' : '';
    const tpStr = p.tp ? (typeof p.tp === 'number' ? '$' + formatFixed(p.tp, 4) : p.tp) : 'Follow Master';
    const slStr = p.sl ? (typeof p.sl === 'number' ? '$' + formatFixed(p.sl, 4) : p.sl) : 'Follow Master';
    const ageStr = p.ts ? formatAge(p.ts) : '-';
    
    return '<div class="position-card" style="padding: 8px 0; border-bottom: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px;">' +
      '<div style="display: flex; justify-content: space-between; align-items: center;">' +
        '<span>' +
          '<b style="font-size: 13px;">' + p.symbol + '</b>' +
          '<span class="pill ' + (p.side === 'LONG' ? 'online' : 'off') + '" style="font-size: 9px; padding: 1px 4px; margin-left: 6px;">' + p.side + '</span>' +
          '<span style="font-size: 10px; color: var(--text-secondary); margin-left: 6px;">' + p.size + '</span>' +
        '</span>' +
        '<b class="' + color + '" style="font-size: 13px;">' + sign + '$' + Math.abs(p.upnl).toFixed(2) + '</b>' +
      '</div>' +
      '<div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-secondary); font-family: monospace;">' +
        '<span>At: <b style="color: var(--text-primary);">' + formatFixed(p.entry, 4) + '</b></span>' +
        '<span>TP: <b style="color: var(--pos-green);">' + tpStr + '</b></span>' +
        '<span>SL: <b style="color: var(--neg-red);">' + slStr + '</b></span>' +
        '<span style="color: var(--text-quaternary);">' + ageStr + '</span>' +
      '</div>' +
    '</div>';
  }).join('') || '<div class="row" style="padding:10px 0;"><span class="label">no open client positions</span></div>';

  // Filter Master target positions
  let activePos = cb.active_positions || [];
  if (activeFilterWallet) {
    activePos = activePos.filter(p => p.wallet && p.wallet.toLowerCase() === activeFilterWallet.toLowerCase());
  }

  // Render Master target positions
  document.getElementById('cobot-master-active').innerHTML = activePos.map(p => {
    const color = p.upnl >= 0 ? 'pos' : 'neg';
    const sign = p.upnl >= 0 ? '+' : '';
    const isFiltered = activeFilterWallet === p.wallet;
    const tpStr = p.tp ? (typeof p.tp === 'number' ? '$' + formatFixed(p.tp, 4) : p.tp) : 'Follow Master';
    const slStr = p.sl ? (typeof p.sl === 'number' ? '$' + formatFixed(p.sl, 4) : p.sl) : 'Follow Master';
    const ageStr = p.ts ? formatAge(p.ts) : '-';
    
    return '<div class="position-card" style="padding: 8px 0; border-bottom: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px;">' +
      '<div style="display: flex; justify-content: space-between; align-items: center;">' +
        '<span>' +
          '<b style="font-size: 13px;">' + p.market + '</b>' +
          '<span class="pill ' + (p.side === 'BUY' || p.side === 'LONG' ? 'online' : 'off') + '" style="font-size: 9px; padding: 1px 4px; margin-left: 6px;">' + p.side + '</span>' +
          '<span style="font-size: 10px; color: var(--text-secondary); margin-left: 6px;">' + (p.size || p.qty || '') + '</span>' +
        '</span>' +
        '<b class="' + color + '" style="font-size: 13px;">' + sign + '$' + Math.abs(p.upnl).toFixed(2) + '</b>' +
      '</div>' +
      '<div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-secondary); font-family: monospace;">' +
        '<span>At: <b style="color: var(--text-primary);">' + formatFixed(p.entry, 4) + '</b></span>' +
        '<span>TP: <b style="color: var(--pos-green);">' + tpStr + '</b></span>' +
        '<span>SL: <b style="color: var(--neg-red);">' + slStr + '</b></span>' +
        '<span><a class="wallet-link mono ' + (isFiltered ? 'filter-active' : '') + '" style="font-size:10px;" onclick="filterWallet(\\\'' + p.wallet + '\\\')">' + (p.wallet ? p.wallet.slice(0,6) + '...' + p.wallet.slice(-4) : '-') + '</a></span>' +
      '</div>' +
    '</div>';
  }).join('') || '<div class="row"><span class="label">none</span></div>';

  // Filter trade history
  let historyTrades = cb.history || [];
  if (activeFilterWallet) {
    historyTrades = historyTrades.filter(h => h.wallet && h.wallet.toLowerCase() === activeFilterWallet.toLowerCase());
  }

  // Render trade history
  document.getElementById('cobot-hist').innerHTML = historyTrades.map(h => {
    const color = h.pnl >= 0 ? 'pos' : 'neg';
    const sign = h.pnl >= 0 ? '+' : '';
    const pnlStr = h.pnl !== null ? sign + formatFixed(h.pnl, 2) : '-';
    return '<div class="grid4-row">' +
      '<span><b>' + h.market + '</b> <b class="' + (h.side === 'BUY' ? 'pos' : 'neg') + '">' + h.side + '</b></span>' +
      '<span class="mono" style="font-size:10px;">' + formatFixed(h.entry, 4) + ' / ' + formatFixed(h.exit, 4) + '</span>' +
      '<span class="' + color + '">' + pnlStr + '</span>' +
      '<span class="pill mono ' + (h.status === 'closed' ? 'online' : 'off') + '" style="font-size:9px; justify-self:start; padding:1px 5px;">' + h.status + '</span>' +
    '</div>';
  }).join('') || '<div class="row"><span class="label">none</span></div>';
}

function renderKalaiPositions() {
  if (!lastKalaiData) return;
  const d = lastKalaiData;
  document.getElementById('poscount').textContent = d.pos.length;
  document.getElementById('positions').innerHTML = d.pos.length ? d.pos.map(p => {
    const color = p.upnl >= 0 ? 'pos' : 'neg';
    const sign = p.upnl >= 0 ? '+' : '';
    const tpStr = p.tp ? '$' + formatFixed(p.tp, 4) : '-';
    const slStr = p.sl ? '$' + formatFixed(p.sl, 4) : '-';
    const ageStr = p.ts ? formatAge(p.ts) : '-';
    
    return '<div class="position-card" style="padding: 8px 0; border-bottom: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px;">' +
      '<div style="display: flex; justify-content: space-between; align-items: center;">' +
        '<span>' +
          '<b style="font-size: 13px;">' + p.s + '</b>' +
          '<span class="pill ' + (p.side === 'LONG' ? 'online' : 'off') + '" style="font-size: 9px; padding: 1px 4px; margin-left: 6px;">' + p.side + '</span>' +
          '<span style="font-size: 10px; color: var(--text-secondary); margin-left: 6px;">' + Math.abs(p.a) + '</span>' +
        '</span>' +
        '<b class="' + color + '" style="font-size: 13px;">' + sign + '$' + Math.abs(p.upnl).toFixed(2) + '</b>' +
      '</div>' +
      '<div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-secondary); font-family: monospace;">' +
        '<span>At: <b style="color: var(--text-primary);">' + formatFixed(p.entry, 4) + '</b></span>' +
        '<span>TP: <b style="color: var(--pos-green);">' + tpStr + '</b></span>' +
        '<span>SL: <b style="color: var(--neg-red);">' + slStr + '</b></span>' +
        '<span style="color: var(--text-quaternary);">' + ageStr + '</span>' +
      '</div>' +
    '</div>';
  }).join('') : '<div class="row"><span class="label">none</span></div>';
}

async function load() {
  try {
    const r = await fetch('/api'); 
    const d = await r.json();
    document.getElementById('ts').textContent = 'Updated ' + new Date(d.ts).toLocaleString();
    const e = document.getElementById('errs'); e.textContent = d.errs; e.className = 'val ' + (d.errs>0?'red':'green');
    
    document.getElementById('modes').innerHTML = d.modes.map(m =>
      '<div class="row"><span class="label">'+m.name+'</span><span class="pill '+(m.status==='online'?'online':'off')+'">'+m.status+' '+(m.uptime>0?Math.round(m.uptime/60)+'m':'')+'</span></div>').join('');
    
    document.getElementById('recent').innerHTML = d.recent.length ? d.recent.map(l => '<div>'+l.slice(0,90)+'</div>').join('') : '<div>none</div>';
    
    lastKalaiData = d;
    calcLiveStats();
    renderKalaiPositions();
  } catch (err) { console.error('API load err', err); }

  try {
    const b = await (await fetch('/bots')).json();
    
    // --- COBOT DATA RENDER ---
    const cb = b.cobot || {};
    if (cb.error) {
      document.getElementById('cobot-balance').textContent = 'ERROR';
      document.getElementById('cobot-upnl').textContent = 'ERROR';
      document.getElementById('cobot-trades').textContent = 'ERROR';
      document.getElementById('cobot-last').textContent = cb.error;
    } else {
      document.getElementById('cobot-trades').textContent = cb.trades || '0';
      document.getElementById('cobot-last').textContent = (cb.last_action || 'none') + ' (' + (cb.last_mode || 'none') + ', score ' + (cb.last_score || '0') + ')';
      
      lastCobotData = cb;
      calcLiveStats();
      renderCobotLists();
    }

    // --- MERIDIAN DATA RENDER ---
    const md = b.meridian || {};
    if (md.error) {
      document.getElementById('meridian-decisions').textContent = 'ERROR';
      document.getElementById('meridian-last-type').textContent = md.error;
    } else {
      document.getElementById('meridian-decisions').textContent = md.decisions || '0';
      document.getElementById('meridian-last-type').textContent = md.last_type || 'none';
      document.getElementById('meridian-last-summary').textContent = md.last_summary || 'none';
      
      // Profiles stat rows
      let statsHtml = '';
      if (md.types) {
        for (const k of Object.keys(md.types)) {
          statsHtml += '<div class="row"><span class="label">' + k + ' Profile</span><span class="val">' + md.types[k] + '</span></div>';
        }
      }
      document.getElementById('meridian-stats').innerHTML = statsHtml || '<div class="row"><span class="label">no stats</span></div>';

      // Meridian Decision List History
      document.getElementById('meridian-history').innerHTML = (md.history || []).map(h => {
        const tStr = new Date(h.timestamp || Date.now()).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        return '<div class="grid-row">' +
          '<span class="mono" style="color: var(--text-quaternary);">' + tStr + '</span>' +
          '<span><b style="color: var(--warn-orange);">' + h.type + '</b></span>' +
          '<span style="font-size:10px; color: var(--text-secondary); text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">' + h.summary + '</span>' +
        '</div>';
      }).join('') || '<div class="row"><span class="label">none</span></div>';
    }
  } catch (err) { console.error('Bots load err', err); }

  // --- TRENCHESS DATA RENDER ---
  await renderTrenchess();
}

let dexCache = {};

async function fetchDexInfo(ca) {
  if (!ca) return null;
  if (dexCache[ca]) return dexCache[ca];
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + ca);
    const data = await res.json();
    if (data && data.pairs && data.pairs.length > 0) {
      const pair = data.pairs[0];
      const info = {
        symbol: pair.baseToken ? pair.baseToken.symbol : '?',
        price: pair.priceUsd ? '$' + parseFloat(pair.priceUsd).toFixed(6) : '-',
        change24h: pair.priceChange && pair.priceChange.h24 ? pair.priceChange.h24 : 0,
        volume24h: pair.volume && pair.volume.h24 ? '$' + Math.round(pair.volume.h24).toLocaleString() : '-',
        liquidity: pair.liquidity && pair.liquidity.usd ? '$' + Math.round(pair.liquidity.usd).toLocaleString() : '-',
        url: pair.url
      };
      dexCache[ca] = info;
      return info;
    }
  } catch (e) {
    console.error('DexScreener err for', ca, e);
  }
  return null;
}

async function renderTrenchess() {
  try {
    const r = await fetch('/trenchess');
    const alerts = await r.json();
    
    if (!alerts || alerts.length === 0) {
      document.getElementById('trenchess-list').innerHTML = '<div class="row"><span class="label">no signals yet</span></div>';
      return;
    }
    
    // Filter CA unik agar tidak duplikat
    let seenCAs = new Set();
    let normalized = [];
    
    for (const a of alerts) {
      const authorLower = (a.author || '').toLowerCase();
      // Abaikan bot
      if (authorLower === 'rick' || authorLower.includes('bot')) {
        continue;
      }
      
      if (a.cas && a.cas.length > 0) {
        for (const ca of a.cas) {
          if (!seenCAs.has(ca)) {
            seenCAs.add(ca);
            normalized.push({
              id: a.id + '-' + ca.slice(0, 8),
              ca: ca,
              ts: a.ts
            });
          }
        }
      }
    }
    
    if (normalized.length === 0) {
      document.getElementById('trenchess-list').innerHTML = '<div class="row"><span class="label">no contract addresses found</span></div>';
      return;
    }
    
    let html = '';
    for (const item of normalized) {
      const ageStr = formatAge(item.ts);
      const caHtml = '<div id="dex-' + item.id + '" class="dex-card">' +
        '<div style="font-size:10px; color:var(--text-quaternary);">DexScreener Live Loading...</div>' +
      '</div>';
      
      fetchDexInfo(item.ca).then(info => {
        const el = document.getElementById('dex-' + item.id);
        if (el) {
          if (info) {
            const changeClass = info.change24h >= 0 ? 'pos' : 'neg';
            const changeSign = info.change24h >= 0 ? '+' : '';
            el.innerHTML = '<div class="dex-header">' +
              '<span><b style="color:var(--warn-orange);">' + info.symbol + '</b> <span class="mono" style="font-size:10px;color:var(--text-secondary); cursor:pointer;" onclick="navigator.clipboard.writeText(&quot;' + item.ca + '&quot;)">' + item.ca + ' (click to copy)</span></span>' +
              '<b class="' + changeClass + '">' + info.price + ' (' + changeSign + info.change24h + '%)</b>' +
            '</div>' +
            '<div class="dex-stats">' +
              '<span>Vol 24h: <b>' + info.volume24h + '</b></span>' +
              '<span>Liq: <b>' + info.liquidity + '</b></span>' +
              '<a href="' + info.url + '" target="_blank" class="dex-link">Trade DEX ↗</a>' +
            '</div>';
          } else {
            el.innerHTML = '<div style="font-size:10px; color:var(--text-quaternary); display:flex; justify-content:space-between; align-items:center;">' +
              '<span>CA: <code class="mono" style="color:var(--text-primary); cursor:pointer;" onclick="navigator.clipboard.writeText(&quot;' + item.ca + '&quot;)">' + item.ca + '</code> (click to copy)</span>' +
              '<span style="color:var(--text-quaternary); font-size:9px;">No pair on DexScreener</span>' +
            '</div>';
          }
        }
      });
      
      html += '<div class="position-card" style="padding: 10px 0; border-bottom: 1px solid var(--border-subtle); display: flex; flex-direction: column; gap: 4px;">' +
        '<div style="display: flex; justify-content: space-between; align-items: center;">' +
          '<span style="font-size: 11px; color: var(--text-secondary);">Contract Address Found</span>' +
          '<span style="font-size: 10px; color: var(--text-quaternary); font-family: monospace;">' + ageStr + '</span>' +
        '</div>' +
        caHtml +
      '</div>';
    }
    document.getElementById('trenchess-list').innerHTML = html;
  } catch (err) {
    console.error('Trenchess load err', err);
  }
}

load(); 
setInterval(load, 15000);

const es = new EventSource('/stream');
es.onmessage = (ev) => {
  try {
    const st = JSON.parse(ev.data);
    for (const sym of Object.keys(st)) {
      livePrices[sym] = st[sym].price;
      const el = document.getElementById('px-' + sym);
      if (el) el.textContent = st[sym].price.toFixed(2);
    }
    
    calcLiveStats();
    renderKalaiPositions();
    renderCobotLists();
  } catch {}
};
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  console.error('REQ', req.url);
  if (req.url === '/bots') {
    try { const d = await botsData(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); }
    catch (e) { res.writeHead(500); res.end('{}'); }
  } else if (req.url === '/trenchess') {
    try {
      const tPath = '/home/dwizzy/dwizzyOS/gauss/trenchess/alerts.json';
      let data = [];
      if (fs.existsSync(tPath)) {
        data = JSON.parse(fs.readFileSync(tPath, 'utf8'));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
  } else if (req.url === '/api') {
    try { const d = await snapshot(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); }
    catch (e) { console.error('SNAP ERR', e.message, e.stack); res.writeHead(500); res.end('{}'); }
  } else if (req.url === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const fs = require('fs');
    let last = '';
    const iv = setInterval(() => {
      try {
        const raw = fs.readFileSync(__dirname + '/state.json', 'utf8');
        if (raw !== last) { last = raw; res.write('data: ' + raw + '\n\n'); }
      } catch {}
    }, 500);
    req.on('close', () => clearInterval(iv));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(HTML);
  }
});
server.listen(PORT, () => console.log('KalAI dashboard on :' + PORT));
