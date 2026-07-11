const fs = require('fs');

const URL = 'https://api.hyperdash.com/graphql';
const OUT = __dirname + '/watchlist.json';
const COOKIE = process.env.HYPERDASH_SESSION || 'session_token_v2=16hWtQnj4t455DNb6irn8qsrXsaIBDrA.magO%2BxuahVSa04k%2FtxIVp%2B%2FDw8um%2BR76GDFMRBScqYs%3D';
const GROUPS = ['copytraders', 'extremely_profitable'];

const QUERY = `query GetSystemGroupTraders($groupId: ID!) {
  getSystemGroupTraders(groupId: $groupId) {
    address
    label
    verified
    displayName
    avatar
    twitter
    lastTradeAt
    lastFillAt
    portfolioGraph {
      timestamp
      value
      __typename
    }
    pnl
    perpsEquity
    winrate
    pnlCohort
    sizeCohort
    totalTrades
    totalLongTrades
    totalShortTrades
    totalWinningTrades
    totalLosingTrades
    sharpe
    drawdown
    copyScore
    tag
    topAssets {
      coin
      volume
      pnl
      __typename
    }
    __typename
  }
}`;

function body(groupId) {
  return { operationName: 'GetSystemGroupTraders', variables: { groupId }, query: QUERY };
}

async function fetchGroup(groupId) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cookie': COOKIE,
      'origin': 'https://hyperdash.com',
      'referer': 'https://hyperdash.com/explore/copytraders',
      'user-agent': 'Mozilla/5.0',
    },
    body: JSON.stringify(body(groupId)),
  });
  const json = await res.json();
  return json?.data?.getSystemGroupTraders || [];
}

async function main() {
  const byAddress = new Map();
  for (const groupId of GROUPS) {
    const traders = await fetchGroup(groupId);
    for (const w of traders) {
      const row = {
        address: w.address,
        displayName: w.displayName || w.label || w.address,
        groupId,
        recency: w.lastTradeAt ? `${Math.max(0, Math.round((Date.now() - Number(w.lastTradeAt)) / 3600000))}H AGO` : null,
        roi30d: Number(w.pnl || 0),
        perpEquity: Number(w.perpsEquity || 0),
        copyScore: Number(w.copyScore || 0),
        leverage: 1,
        sumUpnl: Number(w.pnl || 0),
        winrate: Number(w.winrate || 0),
        pnlCohort: w.pnlCohort || null,
        sizeCohort: w.sizeCohort || null,
        totalTrades: Number(w.totalTrades || 0),
        totalWinningTrades: Number(w.totalWinningTrades || 0),
        totalLosingTrades: Number(w.totalLosingTrades || 0),
        drawdown: Number(w.drawdown || 0),
        tag: w.tag || null,
        topAssets: w.topAssets || [],
      };
      const prev = byAddress.get(row.address);
      if (!prev || row.copyScore > prev.copyScore) byAddress.set(row.address, row);
    }
  }
  const rows = [...byAddress.values()].sort((a,b)=>b.copyScore-a.copyScore || b.perpEquity-a.perpEquity);
  if (!rows.length) throw new Error('seed empty: no traders returned');
  fs.writeFileSync(OUT, JSON.stringify(rows, null, 2) + '\n');
  console.log(JSON.stringify({ seeded: rows.length, out: OUT }, null, 2));
}

main().catch(e => { console.error(e.message); process.exit(1); });
