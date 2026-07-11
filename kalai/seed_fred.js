/**
 * Seed FRED macro events into Gebelin TimescaleDB (dwizzyos_ts)
 */
'use strict';

const { Client } = require('pg');
const https = require('https');

const FRED_KEY = process.env.FRED_API_KEY || '588b3b8b5982b4373cd5e93a2ca4d0b5';
const PG_DSN = process.env.PG_DSN ||
  'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';

const SERIES = [
  { id: 'FEDFUNDS', name: 'Fed Funds Rate', kind: 'rate' },
  { id: 'CPIAUCSL', name: 'CPI All Urban',  kind: 'inflation' },
  { id: 'UNRATE',   name: 'Unemployment',   kind: 'labor' },
  { id: 'PAYEMS',   name: 'Nonfarm Payroll', kind: 'labor' },
  { id: 'DGS10',    name: '10Y Treasury',   kind: 'rate' },
];

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => res(d));
    }).on('error', rej);
  });
}

async function main() {
  const pg = new Client({ connectionString: PG_DSN });
  await pg.connect();

  await pg.query(`
    CREATE TABLE IF NOT EXISTS fred_events (
      ts        TIMESTAMPTZ NOT NULL,
      series_id TEXT NOT NULL,
      name      TEXT NOT NULL,
      kind      TEXT NOT NULL,
      value     DOUBLE PRECISION,
      PRIMARY KEY (series_id, ts)
    );
  `);
  await pg.query(
    'SELECT create_hypertable(\'fred_events\', \'ts\', if_not_exists => TRUE);'
  ).catch(() => {});

  for (const s of SERIES) {
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${s.id}&api_key=${FRED_KEY}&file_type=json&sort_order=asc`;
    const json = JSON.parse(await get(url));
    const obs = json.observations || [];
    const rows = obs.filter(o => o.value !== '.').map(o =>
      [o.date + 'T00:00:00Z', s.id, s.name, s.kind, parseFloat(o.value)]
    );
    if (rows.length) {
      const ts = rows.map(r => r[0]);
      const sid = rows.map(r => r[1]);
      const nm = rows.map(r => r[2]);
      const kd = rows.map(r => r[3]);
      const vl = rows.map(r => r[4]);
      await pg.query(
        `INSERT INTO fred_events (ts, series_id, name, kind, value)
         SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::float[])
         ON CONFLICT (series_id, ts) DO UPDATE SET value = EXCLUDED.value`,
        [ts, sid, nm, kd, vl]
      );
      console.log(`${s.id}: ${rows.length} rows`);
    }
  }

  const cnt = await pg.query('SELECT COUNT(*) FROM fred_events');
  console.log('TOTAL fred_events:', cnt.rows[0].count);
  await pg.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
