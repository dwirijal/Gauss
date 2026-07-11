const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const WATCH = path.join(ROOT, 'watchlist.json');
const LEADER = path.join(ROOT, 'leaderboard.json');
const OUT = path.join(ROOT, 'watchlist.pruned.json');

const watch = JSON.parse(fs.readFileSync(WATCH, 'utf8'));
const leader = JSON.parse(fs.readFileSync(LEADER, 'utf8'));
const keep = new Set(leader.filter(w => w.trades >= 3 && w.winrate >= 0.5 && w.pnl >= 0).map(w => w.wallet));
const pruned = watch.filter(w => keep.has(w.address));
fs.writeFileSync(OUT, JSON.stringify(pruned, null, 2) + '\n');
console.log(JSON.stringify({ before: watch.length, after: pruned.length }, null, 2));
