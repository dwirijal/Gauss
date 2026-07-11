const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const JOURNAL = path.join(ROOT, 'trade_journal.json');
const OUT = path.join(ROOT, 'leaderboard.json');

const journal = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
const byWallet = new Map();
for (const t of journal) {
  const w = t.wallet || 'unknown';
  const cur = byWallet.get(w) || { wallet: w, trades: 0, pnl: 0, wins: 0, losses: 0 };
  cur.trades++;
  cur.pnl += Number(t.pnl || 0);
  if (Number(t.pnl || 0) > 0) cur.wins++; else if (Number(t.pnl || 0) < 0) cur.losses++;
  byWallet.set(w, cur);
}
const rows = [...byWallet.values()].map(r => ({
  ...r,
  winrate: r.trades ? +(r.wins / r.trades).toFixed(3) : 0,
})).sort((a,b)=>b.pnl-a.pnl || b.winrate-a.winrate);
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + '\n');
console.log(JSON.stringify({ wallets: rows.length, top: rows.slice(0, 5) }, null, 2));
