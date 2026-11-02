#!/usr/bin/env bash
# kv-pager 端到端：passthrough / save / restore / compaction
# 清场必须按命令行匹配杀 node——pkill 在 Git Bash 上匹配不到 Windows 进程，
# 上一轮残留进程会占着端口并带着旧内存状态应答，导致整轮测试无效（已踩过）。
set -u
cd "$(dirname "$0")" || exit 1
BIN="C:/DDDD/Agent Work/_tmp/b580-mtp-2026-11-01/bin-port/llama-server.exe"
MODEL="C:/DDDD/Agent Work/_tmp/b580-mtp-2026-11-01/Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf"
POOL="$(pwd)/pool"
UP=8080
PG=${PG:-8083}

purge(){
  powershell -NoProfile -Command "Get-Process llama-server -ErrorAction SilentlyContinue | ForEach-Object { taskkill /F /T /PID \$_.Id 2>&1 | Out-Null }" >/dev/null 2>&1
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*kv-pager*' } | ForEach-Object { taskkill /F /T /PID \$_.ProcessId 2>&1 | Out-Null }" >/dev/null 2>&1
  for i in $(seq 1 20); do
    [ -z "$(tasklist 2>/dev/null | grep -i llama-server)" ] && ! curl -sS --max-time 1 "http://127.0.0.1:$PG/pager/stats" >/dev/null 2>&1 && break
    sleep 2
  done
  sleep 3
}

purge
# 再确认端口真的空
if curl -sS --max-time 2 "http://127.0.0.1:$PG/pager/stats" >/dev/null 2>&1; then
  echo "❌ $PG 仍被占用，中止（避免旧进程污染）"; exit 1
fi
rm -rf "$POOL"; mkdir -p "$POOL/raw"

echo "=== 启动 llama-server (ctx 8192, slot-save-path) ==="
"$BIN" -m "$MODEL" -ngl 99 -c 8192 -ctk q8_0 -ctv q8_0 -np 1 --jinja \
  --reasoning-budget 0 --no-webui --host 127.0.0.1 --port $UP \
  --slot-save-path "$POOL/raw" > up.log 2>&1 &
for i in $(seq 1 90); do curl -sS --max-time 2 "http://127.0.0.1:$UP/health" 2>/dev/null | grep -q '"ok"' && { echo "  就绪"; break; }; sleep 2; done

echo "=== 启动 kv-pager (port $PG) ==="
BUDGET_TOKENS=1500 PORT=$PG UPSTREAM="http://127.0.0.1:$UP" POOL_DIR="$POOL" \
  node kv-pager.mjs > pg.log 2>&1 &
for i in $(seq 1 30); do curl -sS --max-time 2 "http://127.0.0.1:$PG/pager/stats" >/dev/null 2>&1 && { echo "  就绪"; break; }; sleep 1; done
grep -q "监听" pg.log || { echo "  pager 未启动:"; tail -5 pg.log; exit 1; }

req(){
  curl -sS --max-time 900 -D "h-$1.txt" -o "r-$1.json" \
    -X POST "http://127.0.0.1:$PG/v1/chat/completions" -H 'Content-Type: application/json' -d @"$2"
  printf "  %-10s %s\n" "$1" "$(grep -iE '^x-kv-pager' "h-$1.txt" | tr -d '\r' | paste -sd' ' -)"
}

node -e '
const fs=require("fs");
const base={role:"system",content:"You are a terse assistant. Answer with one short sentence."};
const q1={role:"user",content:"What is the capital of France?"};
const a1={role:"assistant",content:"Paris."};
fs.writeFileSync("p1.json",JSON.stringify({messages:[base,q1],temperature:0,max_tokens:16,user:"convA"}));
fs.writeFileSync("p2.json",JSON.stringify({messages:[base,q1,a1,{role:"user",content:"And of Japan?"}],temperature:0,max_tokens:16,user:"convA"}));
const filler={role:"user",content:"padding context. ".repeat(400)};
fs.writeFileSync("p3.json",JSON.stringify({messages:[base,q1,a1,filler,{role:"user",content:"What is the capital of France?"}],temperature:0,max_tokens:16,user:"convA"}));
'

echo "=== 1) 首问（应 passthrough）==="; req first p1.json
echo "=== 2) 存快照 ==="; curl -sS --max-time 600 -X POST "http://127.0.0.1:$PG/pager/save" -H 'Content-Type: application/json' -d @p2.json; echo
echo "=== 3) 同前缀再问（应 restored）==="; req again p2.json
echo "=== 4) 超预算（应 compacted 且 dropped>0）==="; req big p3.json
echo
echo "=== stats ==="; curl -sS --max-time 10 "http://127.0.0.1:$PG/pager/stats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("  ",JSON.stringify(j.stats));console.log("   池:",j.pool.map(p=>p.name).join(", ")||"(空)")})'
echo "=== 池内文件 ==="; ls -l "$POOL/raw" 2>/dev/null | grep -v total | awk '{print "  ",$5,$9}'

purge
echo "=== DONE ==="
