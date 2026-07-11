const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const CUR = path.join(ROOT, 'watchlist.json');
const PREV = path.join(ROOT, 'watchlist.prev.json');
const OUT = path.join(ROOT, 'watchlist.diff.json');

function load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }

const cur = load(CUR);
const prev = load(PREV);
const c = new Map(cur.map(w => [w.address, w]));
const p = new Map(prev.map(w => [w.address, w]));
const added = [...c.keys()].filter(k => !p.has(k));
const removed = [...p.keys()].filter(k => !c.has(k));
const kept = [...c.keys()].filter(k => p.has(k));
fs.writeFileSync(OUT, JSON.stringify({ added, removed, kept, count: { added: added.length, removed: removed.length, kept: kept.length } }, null, 2) + '\n');
fs.writeFileSync(PREV, JSON.stringify(cur, null, 2) + '\n');
console.log(JSON.stringify({ added: added.length, removed: removed.length, kept: kept.length }, null, 2));
