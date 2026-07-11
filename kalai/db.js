const { Client } = require('pg');
const PG_DSN = 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
module.exports = { Client, PG_DSN };
