/**
 * RR 1:1 then trailing TP (lock profit, ride momentum)
 * - SL at -sl% (risk $1 fixed)
 * - TP1 at +sl% (RR 1:1 target)
 * - After TP1 hit: trailing TP activates (td% behind), SL moves to entry (break-even)
 */
'use strict';
const { Client } = require('pg');

const PG_DSN = 'postgres://dwizzy:kalai_tdb_2026@172.23.0.2:5432/dwizzyos_ts';
const LEV = parseInt(process.env.LEV || '20', 10);
const MAKER = parseFloat(process.env.FEE || '0.0002');
const TAKER = 0.0005;
const RISK = 1, CAPITAL = 20;

const TD = parseFloat(process.env.TD||'0.3',10);
const PARTIAL = process.env.PARTIAL==='1';
const VOLF = process.env.VOLF==='1';

const REGIME = process.env.REGIME || null;  // BULL|BEAR|CHOPPY|null
function emaArr(closes,p){return require('technicalindicators').EMA.calculate({values:closes,period:p});}
function atrArr(cd){const a=[];for(let i=1;i<cd.length;i++)a.push(Math.max(cd[i].high-cd[i].low,Math.abs(cd[i].high-cd[i-1].close),Math.abs(cd[i].low-cd[i-1].close)));return a;}
function regimeAt(closes,i,e50,atr){const sl=(e50[i]-e50[i-20])/e50[i-20]*100;const vol=atr[i]/closes[i]*100;if(vol>0.8)return 'CHOPPY';if(sl>0.3)return 'BULL';if(sl<-0.3)return 'BEAR';return 'CHOPPY';}

function test(cd, look, sl, td) {
  let w = 0, l = 0, pnl = 0;
  const notional = RISK / (sl / 100);
  const fee = notional * (process.env.MAKER === '0' ? TAKER : MAKER) * 2;
  const EMA_CALC = emaArr(cd.map(x=>x.close),50); const ATR_CALC = atrArr(cd);
  for (let i = look + 1; i < cd.length; i++) {
    const hh = Math.max(...cd.slice(i - look, i).map(c => c.high));
    const ll = Math.min(...cd.slice(i - look, i).map(c => c.low));
    const p = cd[i].close;
    let side = null, entry = p, slc = p * (1 - sl / 100), tpl = p * (1 + sl / 100), trailed = false, qtyLeft = 1;
    if (VOLF) { const avgV = cd.slice(i-20,i).reduce((a,x)=>a+x.volume,0)/20; if (cd[i].volume < avgV*1.5) continue; }
    if (p >= hh * 0.999) side = 'L';
    else if (p <= ll * 1.001) side = 'S';
    else continue;
    if (REGIME && regimeAt(cd.map(x=>x.close), i, EMA_CALC, ATR_CALC) !== REGIME) continue;
    for (let j = i + 1; j < Math.min(i + 600, cd.length); j++) {
      const pj = cd[j].close;
      const hi = cd[j].high, lo = cd[j].low;
      if (!trailed) {
        const hitTp1 = side === 'L' ? hi >= tpl : lo <= (entry * (1 - sl / 100) * 2 - entry);  // same as tpl
        if (hitTp1) {
          trailed = true; slc = entry;
          if (PARTIAL) { const pp = side==='L' ? (tpl-entry)/entry*100 : (entry-tpl)/entry*100; pnl += notional*0.5*(pp/100) - fee*0.5; qtyLeft = 0.5; w++; }
        }
      }
      if (trailed) {
        const tpNow = side === 'L' ? pj * (1 - td / 100) : pj * (1 + td / 100);
        const hitTrail = side === 'L' ? lo <= tpNow : hi >= tpNow;
        if (hitTrail) {
          const exit = tpNow;
          const pp = side === 'L' ? (exit - entry) / entry * 100 : (entry - exit) / entry * 100;
          pnl += notional * qtyLeft * (pp / 100) - fee * qtyLeft; if (pp > 0) w++; else l++; break;
        }
      } else {
        const hitSl = side === 'L' ? lo <= slc : hi >= slc * (2 - 1);
        const hitTp1 = side === 'L' ? hi >= tpl : lo <= (entry * (1 - sl / 100));
        if (hitTp1) { // RR achieved but trailing not yet flagged in this branch; flag & continue
          trailed = true; slc = entry; continue;
        }
        if (hitSl) {
          const pp = side === 'L' ? (slc - entry) / entry * 100 : (entry - slc) / entry * 100;
          pnl += notional * qtyLeft * (pp / 100) - fee * qtyLeft; if (pp > 0) w++; else l++; break;
        }
      }
    }
  }
  return { wr: +((w / (w + l)) * 100).toFixed(1), n: w + l, pnl: +pnl.toFixed(2), roi: +(pnl / CAPITAL * 100).toFixed(0) };
}

(async () => {
  const pg = new Client({ connectionString: PG_DSN }); await pg.connect();
  for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    for (const iv of ['15m', '1h', '4h']) {
      const r = await pg.query('SELECT close,high,low FROM market_data WHERE symbol=$1 AND interval=$2 ORDER BY ts DESC LIMIT $3', [sym, iv, 6000]);
      const cd = r.rows.reverse();
      const SL_OV = parseFloat(process.env.SL_OVERRIDE||'0.5',10); const res = test(cd, 20, SL_OV, TD);
      console.log(`${sym} ${iv} RR1:1+trailTP td=0.3: WR=${res.wr}% N=${res.n} PnL=$${res.pnl} ROI=${res.roi}%`);
    }
  }
  await pg.end();
})().catch(e => { console.error(e.message); process.exit(1); });
