#!/usr/bin/env bash
# Gauss CTO watchdog — keeps PM2 + Cobot alive, flags stale data.
# ponytail: cron-driven; PM2 covers crash-restart, this covers PM2-down + missing Cobot + stale signals.
set -u
LOG=/home/dwizzy/dwizzyOS/gauss/watchdog.log
ROOT=/home/dwizzy/dwizzyOS/gauss
ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "$(ts) $*" >>"$LOG"; }

# 1. PM2 itself up?
if ! pgrep -x pm2 >/dev/null 2>&1 && ! pm2 ping >/dev/null 2>&1; then
  log "PM2 down — restarting daemon"
  pm2 resurrect >/dev/null 2>&1 || true
fi

# 2. Required PM2 processes present + online (restart by real entry script, never mislabel)
# ponytail: map name->entry; if a proc is missing entirely, spawn its true entry, not index.js mislabeled.
declare -A ENTRY=( ["kalai-scalping"]="$ROOT/kalai/index.js" ["kalai-intraday"]="$ROOT/kalai/index.js" ["kalai-swing"]="$ROOT/kalai/index.js" ["kalai-dashboard"]="$ROOT/kalai/dashboard.js" ["meridian"]="$ROOT/meridian/index.js" )
for p in "${!ENTRY[@]}"; do
  st=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);const m=a.find(x=>x.name===process.argv[1]);console.log(m?m.pm2_env.status:"MISSING")})' "$p")
  if [ "$st" != "online" ]; then
    log "$p not online ($st) — restart"
    pm2 restart "$p" >/dev/null 2>&1 || pm2 start "${ENTRY[$p]}" -n "$p" >/dev/null 2>&1
  fi
done

# 3. Cobot — owned by PM2 (cron-restart 1m, autorestart off). Only revive if PM2 lost it.
cb=$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s);console.log(a.some(x=>x.name==="cobot")?"1":"0")})')
if [ "$cb" != "1" ]; then
  log "Cobot missing from PM2 — re-adding"
  (cd "$ROOT/cobot" && pm2 start bot.js --name cobot --interpreter node --cron-restart="*/1 * * * *" --no-autorestart) >/dev/null 2>&1
fi

# 4. Stale-data guard: kalai learning_log untouched >30m = signal engine dead
LF=$ROOT/kalai/learning_log.json
if [ -f "$LF" ]; then
  ago=$(( ($(date +%s) - $(stat -c %Y "$LF")) / 60 ))
  if [ "$ago" -gt 30 ]; then
    log "WARN learning_log stale ${ago}m — scalping may be stuck"
  fi
fi
