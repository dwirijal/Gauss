#!/usr/bin/env python3
"""KalAI demo monitor — report PnL, open positions, errors every tick."""
import os, subprocess, json, sys

JS = r'''
const fs=require("fs");
const axios=require("axios");const crypto=require("crypto");
const env={};
for(const line of fs.readFileSync(process.env.HOME+"/.hermes/.env","utf8").split("\n")){
  const t=line.trim(); if(t.startsWith("BINANCE_DEMO2_")){const i=t.indexOf("=");env[t.slice(0,i)]=t.slice(i+1);}
}
const key=env.BINANCE_DEMO2_API_KEY, sec=env.BINANCE_DEMO2_SECRET;
const base="https://testnet.binancefuture.com";
const mk=q=>{const ts=Date.now();const qs=(q?q+"&":"")+"timestamp="+ts+"&recvWindow=5000";return qs+"&signature="+crypto.createHmac("sha256",sec).update(qs).digest("hex");};
const hdr={"X-MBX-APIKEY":key};
(async()=>{
  const acct=await axios.get(base+"/fapi/v2/account?"+mk(""),{headers:hdr}).then(r=>r.data).catch(e=>null);
  const bal=acct?+(acct.totalMarginBalance||acct.totalWalletBalance||0):0;
  const upnl=acct?+acct.totalUnrealizedProfit:0;
  const pr=await axios.get(base+"/fapi/v2/positionRisk?"+mk(""),{headers:hdr}).then(r=>r.data).catch(e=>[]);
  const pos=pr.filter(p=>Math.abs(parseFloat(p.positionAmt))>0.0001).map(p=>({s:p.symbol,a:+p.positionAmt,upnl:+p.unRealizedProfit,entry:+p.entryPrice}));
  console.log(JSON.stringify({bal,upnl,pos}));
})().catch(e=>console.log(JSON.stringify({err:e.message})));
'''
open('/home/dwizzy/dwizzyOS/gauss/kalai/.kalai_mon.js','w').write(JS)
r = subprocess.run(['node','/home/dwizzy/dwizzyOS/gauss/kalai/.kalai_mon.js'], capture_output=True, text=True,
                   cwd='/home/dwizzy/dwizzyOS/gauss/kalai')
try:
    d = json.loads(r.stdout.strip())
except:
    print("MONITOR ERR: " + r.stdout[:200] + r.stderr[:200]); sys.exit(0)

lines = []
lines.append("📊 **KalAI Demo Monitor**")
lines.append(f"💰 Equity: ${d.get('bal',0):.2f} | uPnL: ${d.get('upnl',0):.2f}")
pos = d.get('pos', [])
if pos:
    lines.append(f"📈 Open positions ({len(pos)}):")
    for p in pos:
        side = "LONG" if p['a']>0 else "SHORT"
        lines.append(f"  {p['s']} {side} {abs(p['a'])} @ {p['entry']} | uPnL ${p['upnl']:.2f}")
else:
    lines.append("✅ No open positions")

err = subprocess.run("grep -c '' ~/.pm2/logs/kalai-*-error.log 2>/dev/null | awk -F: '{s+=$2} END{print s}'",
                     shell=True, capture_output=True, text=True).stdout.strip()
lines.append(f"⚠️ Errors (24h log): {err or 0}")

sig = subprocess.run("grep -h 'EXEC\\|SIGNAL' ~/.pm2/logs/kalai-*.out.log 2>/dev/null | tail -3",
                     shell=True, capture_output=True, text=True).stdout.strip()
if sig:
    lines.append("🎯 Recent:")
    for l in sig.split('\n')[:3]:
        lines.append("  " + l[:80])

print('\n'.join(lines))
