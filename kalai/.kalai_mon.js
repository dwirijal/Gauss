
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
