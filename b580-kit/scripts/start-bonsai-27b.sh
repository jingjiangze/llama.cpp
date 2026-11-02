#!/usr/bin/env bash
# QWEN3.8 生产启动器（自包含：模型 / 二进制 / 代理都在本目录下）
#
# 实测基线（Arc B580 12GB / Windows / Vulkan）：
#   模型 r3 Q4_0 MTP 头，草稿接受率 77–100%
#   q4_0 KV + ctx 131072：64K/96K/112K/128K 四档同速，160K 起掉速
#   MTP 净加速随深度衰减：1K 1.52x / 4K 1.31x / 8K 1.21x / 12K 1.05x / 20K 0.92x
#     ⇒ 默认 SPEC_DEPTH=8192，深处自动停草稿（实测 21K 提示 draft_n=0）
#
# 用法：
#   bash start-bonsai-27b.sh
#   CTX=65536 bash start-bonsai-27b.sh     # 小上下文更快（见 README）
#   MTP=0 bash start-bonsai-27b.sh         # 关投机（追速度时通常更慢，仅排障用）
set -u
cd "$(dirname "$0")" || exit 1

BIN="${BIN:-./bin/bin-port/llama-server.exe}"
MODEL="${MODEL:-./models/Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf}"
PORT="${PORT:-8080}"
CTX="${CTX:-131072}"
KV="${KV:-q4_0}"
RBUDGET="${RBUDGET:-0}"
ALIAS="${ALIAS:-bonsai-27b}"
MTP="${MTP:-1}"
SPEC_NMAX="${SPEC_NMAX:-2}"
SPEC_DEPTH="${SPEC_DEPTH:-8192}"
API_KEY="${API_KEY:-}"

[ -x "$BIN" ]   || { echo "[launch] 找不到可执行文件: $BIN" >&2; exit 1; }
[ -f "$MODEL" ] || { echo "[launch] 找不到模型: $MODEL" >&2; exit 1; }

EXTRA=()
[ -n "$ALIAS" ] && EXTRA+=(--alias "$ALIAS")
[ -n "$API_KEY" ] && EXTRA+=(--api-key "$API_KEY")
[ -n "${SLOT_SAVE_PATH:-}" ] && EXTRA+=(--slot-save-path "$SLOT_SAVE_PATH")

SPEC=""
# 只有模型文件名带 mtp 时才开投机（基础模型没有 nextn 块，开了会报错）
case "$MODEL" in
  *[mM][tT][pP]*)
    if [ "$MTP" = "1" ]; then
      SPEC="--spec-type draft-mtp --spec-draft-n-max ${SPEC_NMAX}"
      [ "${SPEC_DEPTH}" != "0" ] && SPEC="$SPEC --spec-draft-depth-max ${SPEC_DEPTH}"
    fi
    ;;
esac

exec "$BIN" \
  -m "$MODEL" \
  -ngl 99 \
  -c "$CTX" \
  -ctk "$KV" -ctv "$KV" \
  -np 1 \
  --jinja \
  --reasoning-budget "$RBUDGET" \
  --no-webui \
  --host 127.0.0.1 --port "$PORT" \
  $SPEC \
  "${EXTRA[@]}"
