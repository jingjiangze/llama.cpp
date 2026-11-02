#!/usr/bin/env bash
# QWEN3.8 生产链路：llama-server(8080) + kv-pager(8081)
#
#   :8080  llama-server 本体（OpenAI 兼容）
#   :8081  kv-pager     推荐入口（页池复用 / 截断续写 / 用量·自检 / 请求净化）
#
# 日志分开写（Windows 上多句柄写同一文件会 Device or resource busy）：
#   llama-server -> logs/server.log    kv-pager -> logs/pager.log    启动器 -> logs/serve.log
set -u
cd "$(dirname "$0")" || exit 1

POOL="${POOL:-./pool}"
UP_PORT="${PORT:-8080}"
PG_PORT="${PG_PORT:-8081}"
BUDGET_TOKENS="${BUDGET_TOKENS:-120000}"

mkdir -p "$POOL/raw" logs

echo "[serve] 启动 llama-server :$UP_PORT"
SLOT_SAVE_PATH="$POOL/raw" bash start-bonsai-27b.sh >> logs/server.log 2>&1 &
SRV=$!

ok=0
for i in $(seq 1 150); do
  if curl -sS --max-time 2 "http://127.0.0.1:$UP_PORT/health" 2>/dev/null | grep -q '"ok"'; then
    ok=1; echo "[serve] llama-server 就绪"; break
  fi
  if ! kill -0 "$SRV" 2>/dev/null; then
    echo "[serve] llama-server 启动失败，见 logs/server.log"; exit 1
  fi
  sleep 2
done
[ "$ok" -eq 1 ] || { echo "[serve] llama-server 超时未就绪"; exit 1; }

echo "[serve] 启动 kv-pager :$PG_PORT（预算 ${BUDGET_TOKENS} tok）"
UPSTREAM="http://127.0.0.1:$UP_PORT" PORT="$PG_PORT" POOL_DIR="$POOL" \
  BUDGET_TOKENS="$BUDGET_TOKENS" AUTOSAVE_EVERY="${AUTOSAVE_EVERY:-0}" \
  AUTO_CONTINUE="${AUTO_CONTINUE:-1}" SELFCHECK_MIN_TG="${SELFCHECK_MIN_TG:-25}" \
  node ./kv-pager/kv-pager.mjs >> logs/pager.log 2>&1 &
PG=$!

cleanup(){
  kill "$PG" 2>/dev/null || true
  kill "$SRV" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

while kill -0 "$SRV" 2>/dev/null && kill -0 "$PG" 2>/dev/null; do sleep 5; done
echo "[serve] 有进程退出，收尾"
cleanup
