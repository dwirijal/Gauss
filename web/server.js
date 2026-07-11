import express from 'express';
import fs from 'fs';
import path from 'path';

const app = express();
const root = path.resolve(new URL('.', import.meta.url).pathname);
const cobot = path.resolve(root, '../cobot');
const meridian = path.resolve(root, '../meridian');

const read = (f, d=[]) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

app.get('/health', (_, res) => res.json({ ok: true }));
const copybotSummary = () => {
  const journal = read(path.join(cobot, 'trade_journal.json'));
  const leaderboard = read(path.join(cobot, 'leaderboard.json'));
  const diff = read(path.join(cobot, 'watchlist.diff.json'), { count: {} }).count;
  const pnl = journal.reduce((a, t) => a + Number(t.pnl || 0), 0);
  const spark = journal.slice(-20).map(t => Number(t.pnl || 0));
  const guard = {
    live: process.env.COPYBOT_LIVE === '1',
    maxDailyLoss: process.env.COPYBOT_MAX_DAILY_LOSS || '200',
    maxOpenPositions: process.env.COPYBOT_MAX_OPEN_POSITIONS || '3',
    minLiquidity: process.env.COPYBOT_MIN_LIQUIDITY || '1000000',
  };
  return {
    watchlist: read(path.join(cobot, 'watchlist.json')).length,
    scores: read(path.join(cobot, 'scores.json')).slice(0, 5),
    signals: read(path.join(cobot, 'paper_signals.json')).length,
    journal: journal.slice(-5),
    leaderboard: leaderboard.slice(0, 10),
    diff,
    pnl: +pnl.toFixed(6),
    trades: journal.length,
    lastRun: journal.at(-1)?.ts || null,
    guard,
    spark,
  };
};

app.get('/api/gauss', (_, res) => res.json({
  copybot: copybotSummary(),
  meridian: {
    running: true,
    pid: fs.existsSync('/tmp/meridian.pid') ? fs.readFileSync('/tmp/meridian.pid', 'utf8').trim() : null,
  }
}));

app.get('/api/cobot', (_, res) => res.json(copybotSummary()));

const render = () => {
  const c = copybotSummary();
  const top = c.leaderboard.slice(0, 8).map((w, i) => `<tr><td>${i + 1}</td><td>${w.wallet}</td><td>${w.pnl.toFixed(2)}</td><td>${w.winrate}</td><td>${w.trades}</td></tr>`).join('');
  const kpi = (label, value, cls='') => `<div class="card"><div class="muted">${label}</div><div class="kpi ${cls}">${value}</div></div>`;
  const status = c.pnl >= 0 ? 'ok' : 'bad';
  const spark = c.spark.map(v => `<span style="display:inline-block;width:10px;height:${Math.max(4, Math.min(40, Math.abs(v) / 2))}px;margin-right:4px;background:${v >= 0 ? 'var(--ok)' : 'var(--bad)'};vertical-align:bottom"></span>`).join('');
  return { c, top, kpi, status, spark };
};

app.get('/', (_, res) => {
  const { c, top, kpi, status, spark } = render();
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Gauss</title><style>:root{--bg:#0b0f14;--card:#0f172a;--line:#1f2937;--text:#e5e7eb;--muted:#94a3b8;--ok:#34d399;--bad:#f87171;--accent:#60a5fa}*{box-sizing:border-box}body{font-family:system-ui;background:radial-gradient(circle at top,#111827 0,#0b0f14 60%);color:var(--text);padding:24px;max-width:1200px;margin:auto}.head{display:flex;justify-content:space-between;align-items:end;gap:16px;margin-bottom:18px}.title{font-size:30px;font-weight:800;letter-spacing:-.03em}.sub{color:var(--muted)}.badge{display:inline-block;padding:6px 10px;border:1px solid var(--line);border-radius:999px;color:var(--accent);background:#0b1220}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:linear-gradient(180deg,#111827,#0f172a);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.22)}.muted{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.kpi{font-size:28px;font-weight:800;margin-top:6px}.ok{color:var(--ok)}.bad{color:var(--bad)}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}th{color:var(--muted);font-weight:600}.section{margin-top:14px}.spark{height:44px;display:flex;align-items:end;gap:2px}</style></head><body><div class="head"><div><div class="title">Gauss</div><div class="sub">cobot + meridian</div></div><div class="badge">${status === 'ok' ? 'PnL positive' : 'PnL down'} · ${c.guard.live ? 'LIVE' : 'PAPER'}</div></div><div class="grid">${kpi('Watchlist', c.watchlist)}${kpi('Signals', c.signals)}${kpi('Trades', c.trades)}${kpi('PnL', c.pnl.toFixed(2), status)}${kpi('Diff', c.diff?.added ?? 0)}</div><div class="grid section">${kpi('Last run', c.lastRun || 'n/a')}<div class="card"><div class="muted">Guard</div><div style="margin-top:6px;font-size:14px;line-height:1.5">live: ${c.guard.live ? '1' : '0'}<br>max loss: ${c.guard.maxDailyLoss}<br>max pos: ${c.guard.maxOpenPositions}<br>min liq: ${c.guard.minLiquidity}</div></div><div class="card"><div class="muted">Spark</div><div class="spark">${spark}</div></div></div><div class="card section"><div class="muted">Top wallets</div><table><thead><tr><th>#</th><th>wallet</th><th>pnl</th><th>winrate</th><th>trades</th></tr></thead><tbody>${top}</tbody></table></div></body></html>`);
});

app.get('/cobot', (_, res) => { const { c, top, kpi, status, spark } = render();
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>Cobot</title><style>:root{--bg:#0b0f14;--card:#0f172a;--line:#1f2937;--text:#e5e7eb;--muted:#94a3b8;--ok:#34d399;--bad:#f87171;--accent:#60a5fa}*{box-sizing:border-box}body{font-family:system-ui;background:radial-gradient(circle at top,#111827 0,#0b0f14 60%);color:var(--text);padding:24px;max-width:1200px;margin:auto}.head{display:flex;justify-content:space-between;align-items:end;gap:16px;margin-bottom:18px}.title{font-size:30px;font-weight:800;letter-spacing:-.03em}.sub{color:var(--muted)}.badge{display:inline-block;padding:6px 10px;border:1px solid var(--line);border-radius:999px;color:var(--accent);background:#0b1220}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:linear-gradient(180deg,#111827,#0f172a);border:1px solid var(--line);border-radius:16px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.22)}.muted{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.kpi{font-size:28px;font-weight:800;margin-top:6px}.ok{color:var(--ok)}.bad{color:var(--bad)}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:14px}th{color:var(--muted);font-weight:600}.section{margin-top:14px}.spark{height:44px;display:flex;align-items:end;gap:2px}</style></head><body><div class="head"><div><div class="title">Cobot</div><div class="sub">copy trading ops</div></div><div class="badge">${status === 'ok' ? 'PnL positive' : 'PnL down'} · ${c.guard.live ? 'LIVE' : 'PAPER'}</div></div><div class="grid">${kpi('Watchlist', c.watchlist)}${kpi('Signals', c.signals)}${kpi('Trades', c.trades)}${kpi('PnL', c.pnl.toFixed(2), status)}${kpi('Diff', c.diff?.added ?? 0)}</div><div class="grid section">${kpi('Last run', c.lastRun || 'n/a')}<div class="card"><div class="muted">Guard</div><div style="margin-top:6px;font-size:14px;line-height:1.5">live: ${c.guard.live ? '1' : '0'}<br>max loss: ${c.guard.maxDailyLoss}<br>max pos: ${c.guard.maxOpenPositions}<br>min liq: ${c.guard.minLiquidity}</div></div><div class="card"><div class="muted">Spark</div><div class="spark">${spark}</div></div></div><div class="card section"><div class="muted">Top wallets</div><table><thead><tr><th>#</th><th>wallet</th><th>pnl</th><th>winrate</th><th>trades</th></tr></thead><tbody>${top}</tbody></table></div></body></html>`);
});

const port = process.env.PORT || 5758;
app.listen(port, () => console.log(`gauss web on ${port}`));
