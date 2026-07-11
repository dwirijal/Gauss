/**
 * Backfill OHLCV into Gebelin TimescaleDB (dwizzyos_ts.market_data)
 * Pulls from ccxt Binance, stores 1h + 4h history for configured pairs.
 */
'use strict';

const ccxt = require('ccxt');
const { Client } = require('pg');

const PG_DSN = process.env.PG_DSN ||
  'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const PAIRS = (process.env.PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
const INTERVALS = (process.env.INTERVALS || '1h,4h').split(',');
const DAYS = parseInt(process.env.DAYS || '400', 10);

async function main() {
  const pg = new Client({ connectionString: PG_DSN });
  await pg.connect();

  await pg.query(`
    CREATE TABLE IF NOT EXISTS market_data (
      ts       TIMESTAMPTZ NOT NULL,
      symbol   TEXT NOT NULL,
      interval TEXT NOT NULL,
      open     DOUBLE PRECISION,
      high     DOUBLE PRECISION,
      low      DOUBLE PRECISION,
      close    DOUBLE PRECISION,
      volume   DOUBLE PRECISION,
      PRIMARY KEY (symbol, interval, ts)
    );
  `);
  await pg.query(
    'SELECT create_hypertable(\'market_data\', \'ts\', if_not_exists => TRUE);'
  ).catch(() => {});

  const ex = new ccxt.binance();
  const since = Date.now() - DAYS * 24 * 3600 * 1000;

  for (const sym of PAIRS) {
    for (const iv of INTERVALS) {
      let all = [];
      let cursor = since;
      while (true) {
        const bars = await ex.fetchOHLCV(sym, iv, cursor, 1000);
        if (!bars.length) break;
        all = all.concat(bars);
        cursor = bars[bars.length - 1][0] + 1;
        if (bars.length < 1000) break;
        if (cursor > Date.now()) break;
      }
      const rows = all.map(b => [
        new Date(b[0]).toISOString(), sym, iv, b[1], b[2], b[3], b[4], b[5],
      ]);
      if (rows.length) {
        const ts = rows.map(r => r[0]);
        const sy = rows.map(r => r[1]);
        const iv2 = rows.map(r => r[2]);
        const o = rows.map(r => r[3]);
        const h = rows.map(r => r[4]);
        const l = rows.map(r => r[5]);
        const c = rows.map(r => r[6]);
        const v = rows.map(r => r[7]);
        await pg.query(
          `INSERT INTO market_data (ts, symbol, interval, open, high, low, close, volume)
           SELECT * FROM UNNEST($1::timestamptz[], $2::text[], $3::text[], $4::float[], $5::float[], $6::float[], $7::float[], $8::float[])
           ON CONFLICT (symbol, interval, ts) DO UPDATE SET
             open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
             close=EXCLUDED.close, volume=EXCLUDED.volume`,
          [ts, sy, iv2, o, h, l, c, v]
        );
      }
      console.log(`${sym} ${iv}: ${rows.length} rows`);
    }
  }
  const cnt = await pg.query('SELECT COUNT(*) FROM market_data');
  console.log('TOTAL market_data:', cnt.rows[0].count);
  await pg.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
