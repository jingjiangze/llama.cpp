#!/usr/bin/env bash
# 最终配置：Ternary-Bonsai-2-27B PTQ1_0 + q8_0 KV
#
# 构建优先级：bin-port > bin-p2
#   bin-port = 移植 Torchit1 Vulkan 优化（三元→int8 coopmat GEMM 等），PR #2 / CI run 41333666453
#              实测 pp128 199.0→520.1 (+161%) / pp512 414.5→835.6 (+102%) / pp2048 392.9→823.1 (+110%)
#              tg128 36.92→36.68 (−0.7%，噪声级)；greedy 输出前 259 字符逐字节一致，之后仅措辞分叉
#   bin-p2   = PrismML 882935398 + 自建 FA 内核 (PR #30641)，保留作为回落
#              （FA 内核的相对收益：6.5K tg +12.8% / 11.9K +36% / 23.8K +61.8%，bin-port 同样含 FA）
#
# 用法：
#   bash start-bonsai-27b.sh                 # 32K 上下文，关思考，无 WebUI
#   CTX=24576 bash start-bonsai-27b.sh       # 长上下文主力档
#   RBUDGET=512 bash start-bonsai-27b.sh     # 难任务才给思考预算
#   BIN=./bin-p2/llama-server.exe bash start-bonsai-27b.sh   # 强制回落旧构建
set -u
cd "$(dirname "$0")" || exit 1

if [ -z "${BIN:-}" ]; then
  if [ -x ./bin-port/llama-server.exe ]; then BIN=./bin-port/llama-server.exe
  else BIN=./bin-p2/llama-server.exe; fi
fi

# MTP 投机：**短上下文才划算，长上下文要关**
#   深度实测（同模型 mtp-lean，200 token 生成）：~30tok 48.6 vs 36.3；~1K 32.2 vs 28.5；
#   ~5.3K 24.1 vs 27.8；~20K 19.2 vs 25.5 ⇒ **交叉点约 2–3K**，更深时 MTP 连 prefill 一起拖慢
#   n-max 扫描（交替测）：1=48.2/49.0，2=46.2/46.4，3=45.4，4=45.5 ⇒ 1 最快
#   chained drafts（LLAMA_MTP_CHAIN=1）在本构建会断言崩溃，不要开
#
# 模型优先级：r3 Q4_0 头（社区 ProCreations，实测接受率 100%）> mtp-lean（41–60%）> 基础版
MTP="${MTP:-1}"
R3_GGUF=./Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf
MTP_GGUF=./Ternary-Bonsai-2-27B-PTQ1_0-mtp-lean.gguf
XDG_MODEL=./Ternary-Bonsai-2-27B-PTQ1_0.gguf
DEFAULT_MODEL="$XDG_MODEL"
[ -f "$MTP_GGUF" ] && DEFAULT_MODEL="$MTP_GGUF"
[ -f "$R3_GGUF" ]  && DEFAULT_MODEL="$R3_GGUF"
MODEL="${MODEL:-$DEFAULT_MODEL}"
SPEC=""
# 只有模型文件名带 mtp 时才开投机（基础版没有 nextn 块，开了会报错）
case "$MODEL" in
  *[mM][tT][pP]*) [ "$MTP" = "1" ] && SPEC="--spec-type draft-mtp --spec-draft-n-max ${SPEC_NMAX:-2}" ;;
esac
PORT="${PORT:-8080}"
CTX="${CTX:-32768}"
KV="${KV:-q8_0}"
RBUDGET="${RBUDGET:-0}"
# 对外提供的模型名与鉴权：ZCode 等 OpenAI 兼容客户端要用
ALIAS="${ALIAS:-bonsai-27b}"
API_KEY="${API_KEY:-}"

# 用数组拼可选参数，避免路径/密钥含空格时被拆开
EXTRA=()
[ -n "$ALIAS" ]   && EXTRA+=(--alias "$ALIAS")
[ -n "$API_KEY" ] && EXTRA+=(--api-key "$API_KEY")
# kv-pager 需要上游能存/取 KV 快照
[ -n "${SLOT_SAVE_PATH:-}" ] && EXTRA+=(--slot-save-path "$SLOT_SAVE_PATH")

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
