const fs = require('fs');

const URL = 'https://api.hyperdash.com/api/hyperliquid/meta-and-asset-ctxs';
const OUT = __dirname + '/asset_ctxs.json';

async function main() {
  const res = await fetch(URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');
  const count = Array.isArray(data) ? data.length : Object.keys(data || {}).length;
  console.log(JSON.stringify({ saved: OUT, count }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
