# b580-kit — Intel Arc B580 上跑 Qwen3.8-27B 本地推理的一整套

面向 **12 GB 单卡、Windows、Vulkan 无 CUDA** 的场景，把「给定硬件上最快的可用配置」
连同可复现步骤、实测数据、以及围绕它的 agent 护栏一起固化下来。

> 所有数字都是本机实测（`llama-bench` / `/v1/chat/completions`），环境与判据写在每张表旁边。
> 没验过的都标了 **PENDING**，不做外推。

---

## 1. 环境（实测机器）

| 项 | 值 |
|---|---|
| GPU | **Intel Arc B580 12 GB**（Xe2 / Battlemage，456 GB/s），Vulkan 后端 |
| CPU / 内存 | i5-13400F / 16 GB DDR4 |
| OS | Windows 11（10.0.26200，x64） |
| 推理引擎 | llama.cpp（prism 系分支 + 移植 Torchit1 的 Vulkan 优化） |
| 构建 | GitHub Actions `build-win-vulkan.yml`（Vulkan SDK 1.4.313.2，MSVC） |

**没有 NVIDIA 卡**，所以 CUDA-only 的一切（KVMem / NInfer / vLLM-XPU / TRT-LLM）都不适用。

---

## 2. 模型：r3 MTP 头是全局最优解

| 项 | 值 |
|---|---|
| 文件 | `Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf` |
| 大小 / SHA256 | 6,185,633,120 B / `4b0e0f9b252d1b77ace4e197f913dbb8729a13c2a0174d4eb8b2b80c22918832` |
| 底座 | Qwen3.8-27B，三值 1.75 bpw（PTQ1_0），65 层（16 层全注意力 + DeltaNet） |
| 草稿头 | 社区 ProCreations r3（Q4_0 量化，基础权重逐字节未改动） |

**它和官方基础模型的差别就是多了第 65 层 MTP 草稿块**。没有这块，`--spec-type draft-mtp` 用不了。

### 自己嫁接（可复现）

```bash
# 1) 头权重（810 MB，SHA256 已钉）
curl -L -x http://127.0.0.1:7897 -o model_mtp.safetensors \
  "https://hf-mirror.com/ProCreations/Ternary-Bonsai-2-27B-MTP/resolve/efffdea64c1f9e93cc7fa6bb24f72ae9d66ecf51/model_mtp.safetensors"
# 期望 SHA256: 7a4a18b2d02116ef184d1b0ee4af46d829825ff2c042f79cf37ef8a03c399218

# 2) 用 KVMem 仓库里的嫁接脚本（钉死了 base/head 双 SHA，基础张量逐字节校验）
python scripts/bonsai-mtp-graft.py \
  --base Ternary-Bonsai-2-27B-PTQ1_0.gguf \
  --head model_mtp.safetensors \
  --output Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf \
  --head-type Q4_0
```

基础模型须是 `SHA256 = 53107f530aa52eb00912263ab1ee29bd199261c87cd7b4ad4ca1318c1fe33ee3`（脚本硬校验）。

---

## 3. 最优配置

```bash
llama-server.exe \
  -m Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf \
  -ngl 99 -c 131072 \
  -ctk q4_0 -ctv q4_0 \
  -np 1 --jinja --reasoning-budget 0 --no-webui \
  --host 127.0.0.1 --port 8080 \
  --spec-type draft-mtp --spec-draft-n-max 2
```

### 为什么是这套

**MTP 在所有深度都赢**（r3 头）：

| 工作深度 | 关 MTP | MTP2 | 增益 |
|---|---|---|---|
| ~4.8K | 27–30 | **50–53** | **+70%** |
| ~16K | 29.9 | **45.0** | **+50%** |
| ~60K | 21.4 | **33.8** | **+58%** |

（旧结论「MTP 深上下文变负」只对弱草稿头 `mtp-lean` 成立，r3 头上不成立。）

**q4 KV 消除了显存悬崖**：q8 在 80K/96K 就掉到 5–7 t/s，q4 到 128K 仍不降速。

| ctx | q4_0 KV 的 tg @60K 深度 |
|---|---|
| 64K / 96K / 112K | 29.3 / 29.5 / 29.6 |
| **128K** | **29.5** |
| 160K | 21.9（掉速，不可用） |

**上下文上限（实测）**：模型原生 262144；开 MTP 时 128K 是可用上限，192K 装不下。

### 已实测排除的旋钮（别重复做）

| 旋钮 | 结果 |
|---|---|
| `--spec-draft-n-max 3` | tg 38.9–46.4，接受率掉到 50.4%（n-max=2 是 48.8–49.6 / 65.1%） |
| `--spec-draft-n-max 4` | tg 37.0–45.4，接受率 45.2% |
| `--spec-draft-p-min 0.5` | 接受率提到 78.9%，但多做的那轮验证吃掉了收益（45.8–47.7 < 48.8–49.6） |
| `--spec-type draft-mtp,ngram-mod` | 全新提示词下接受率**完全相同**（71.78%）、tg 还略慢（50.5 vs 51.5） |
| `--spec-draft-attn-window`（限草稿注意力窗） | 未实现；前置测量显示收益上限 <1%（草稿仅占总时间 8.1%，其中 GPU decode 2.6%） |
| `-nkvo`（KV 放内存） | 能开 256K，但 tg 仅 7.2（PCIe 与显存带宽差 8.9×） |

> 注：ngram 组合出现过一次 116.3 t/s，是**同一提示词第二次请求命中 ngram 缓存**的假象，换新提示词即消失。

**为什么没有更多可调空间**：草稿侧只占 8.1%，损失在**验证侧**——
n-max=2 + 100% 接受 ⇒ 每轮 3 token ⇒ 理论上限 3×，实测 1.5–1.7×，
即一轮验证成本 ≈ 1.8–2.4 倍单 token 解码。这只能靠内核层（更便宜的多行验证）解决，不是配置。

---

## 4. 生产链路

```
客户端 → :8081 kv-pager → :8080 llama-server
```

| 入口 | 用途 |
|---|---|
| `http://127.0.0.1:8081/v1` | **推荐**：带页池复用、截断续写、用量自检 |
| `http://127.0.0.1:8080/v1` | 直连本体（pager 挂了也不影响） |

模型 id `bonsai-27b`，**不需要 API key**（只绑回环）。

启动：`scripts/serve.cmd`（内部 `serve-prod.sh`，**不设守护进程**）。

| 路径 | 作用 |
|---|---|
| `GET /pager/usage` | `n_ctx` / 预算 / 已用 / 剩余% / 槽位忙闲 |
| `GET /pager/selfcheck` | 跑固定任务量真实 tg，低于阈值告警（专治"能加载但只有 5 t/s"） |
| `POST /pager/save` | 存 KV 快照（**约 450 MiB/份**，默认不自动存） |

---

## 5. Agent 护栏（`agent-guards/`）

| 模块 | 作用 | 自测 |
|---|---|---|
| `edit-guard.mjs` | 单文件精确替换的**执行前校验**（目标/动作/old-new/唯一性）+ 执行后验收 | 12/12 |
| `task-ledger.mjs` | 多动作任务的剩余动作账本，想停时提醒 | 10/10 |
| `structured-feedback.mjs` | 工具失败回**结构化**反馈（码/可重试/下一步），而非自由文本 | 18/18 |

零依赖纯 ESM，可当库用或当钩子进程用（`--stdin-json`，退出码表达 allow/deny）。

---

## 6. KV 页池（`kv-pager/`）

L0 实现：**前缀/轮次级** KV 快照复用（走 llama-server 的 `slot save/restore`），不是 KV 页级。
真页级要改什么，见 `kv-pager/PAGE-LEVEL-AUDIT.md`（L1 mask 选择 80–150 行但不提速 /
**L2 驻留窗口 450–850 行** / L3 内核 1000+ 行）。

`lib.mjs` 自测 20/20，`e2e.sh` 覆盖 passthrough / save / restored / compacted 四条路径。

---

## 7. 明确的边界（不要外推）

1. 本 kit 只在 **Arc B580 + Windows + Vulkan** 上实测。
2. 128K 是「开 MTP + q4」的可用上限；**256K 装不下**，是 12 GB 的硬边界。
3. 长提示词 prefill 很慢：64K 一次约 **507 秒**（125 t/s），物理限制。
4. `--ctx-checkpoints` 是内存唯一"不掉速"的用法（前缀快照复用），不是扩上下文。
5. 真页级 KV 回迁未实现，只做了审计。
6. `response_format` / `json_schema` / `grammar` 上游都支持，但本 kit 没做默认注入。
7. 生态盘点结论：**只有 PrismML fork 有 Vulkan 三元内核**；BitNet.cpp / T-MAC 均无 GPU 路径；
   Intel 自己的 Xe2 2-bit 论文（arXiv 2508.06753，用 Bonsai 27B 评测、端到端最高 6.7×）**无公开代码**。

---

## 8. 与 llama.cpp 上游的关系

引擎侧改动（Vulkan 内核移植、`p=128` 偏移排除等）在 `port/torchit-vk` 分支与对应 Release 里，不在本目录。
本目录只放**配置、脚本、护栏、代理**这类与推理内核解耦的东西。
