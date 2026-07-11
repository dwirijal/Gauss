#!/usr/bin/env node
// KalAI AI Monitor — reads bot logs, analyzes trade performance, sends analyzed report to Telegram
const fs = require('fs');
const { execSync } = require('child_process');
const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN = '8875549341:AAE6FgjY0U-Zqf-aVfVR0MPMx333X2IFccg';
const CHAT_ID = '722947356';
const LOGS = {
  scalping: process.env.HOME + '/.pm2/logs/kalai-scalping-out.log',
  intraday: process.env.HOME + '/.pm2/logs/kalai-intraday-out.log',
  swing:    process.env.HOME + '/.pm2/logs/kalai-swing-out.log',
};

function loadEnv() {
  const env = {};
  for (const ln of fs.readFileSync(process.env.HOME + '/.hermes/.env', 'utf8').split('\n')) {
    const t = ln.trim();
    if (t.startsWith('BINANCE_DEMO2_')) { const i = t.indexOf('='); env[t.slice(0,i)] = t.slice(i+1); }
  }
  return env;
}
const ENV = loadEnv();
const KEY = ENV.BINANCE_DEMO2_API_KEY || '', SEC = ENV.BINANCE_DEMO2_SECRET || '';
const BASE = 'https://testnet.binancefuture.com';

function getJSON(url) {
  return new Promise((resolve) => {
    const ts = Date.now();
    const paramStr = url.includes('?') ? url.split('?')[1] : '';
    const qs = 'timestamp=' + ts + '&recvWindow=5000';
    const sig = crypto.createHmac('sha256', SEC).update(paramStr + qs).digest('hex');
    https.get(url + '?' + qs + '&signature=' + sig, { headers: { 'X-MBX-APIKEY': KEY } }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{resolve(JSON.parse(d));}catch{resolve(null);}});
    }).on('error',()=>resolve(null));
  });
}

function parseTrades(logPath) {
  if (!fs.existsSync(logPath)) return { exec: 0, signals: 0, skips: 0, lastExec: null };
  const txt = fs.readFileSync(logPath, 'utf8');
  let exec = 0, signals = 0, skips = 0, lastExec = null;
  for (const ln of txt.split('\n')) {
    if (ln.includes('[EXEC]')) { exec++; lastExec = ln; }
    if (ln.includes('[SIGNAL]')) { if (ln.includes('SKIP')) skips++; else signals++; }
  }
  return { exec, signals, skips, lastExec };
}

async function main() {
  const acct = await getJSON(`${BASE}/fapi/v2/account`);
  const equity = acct ? +(acct.totalMarginBalance || acct.totalWalletBalance || 0) : 0;
  const pnl = equity - 5000;
  let msg = `🤖 <b>KalAI Bot Monitor</b> — ${new Date().toISOString().slice(0,16)} UTC\n`;
  msg += `💰 Equity: $${equity.toFixed(2)} | Net PnL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\n\n`;
  for (const [mode, path] of Object.entries(LOGS)) {
    const s = parseTrades(path);
    msg += `<b>${mode.toUpperCase()}</b>: exec=${s.exec} sig=${s.signals} skip=${s.skips}\n`;
    if (s.exec > 0 && s.lastExec) msg += `  • Last: ${s.lastExec.replace(/\[EXEC\] /,'').slice(0,70)}\n`;
    else if (s.skips > s.signals) msg += `  • 📉 Choppy — waiting breakout\n`;
    else msg += `  • ⏳ No signal yet\n`;
  }
  msg += `\n<i>Demo acct, risk $1/trade. Live test.</i>`;
  sendTelegram(msg.trim());
  console.log(msg);
}

function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&parse_mode=HTML&text=${encodeURIComponent(text)}`;
  https.get(url, () => {}).on('error', () => {});
}

main();
