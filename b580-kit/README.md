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

## 2. 模型：r3 MTP 头

| 项 | 值 |
|---|---|
| 文件 | `Ternary-Bonsai-2-27B-PTQ1_0-MTP-r3-Q4_0.gguf` |
| 大小 / SHA256 | 6,185,633,120 B / `4b0e0f9b252d1b77ace4e197f913dbb8729a13c2a0174d4eb8b2b80c22918832` |
| 底座 | Qwen3.8-27B，三值 1.75 bpw（PTQ1_0），65 层（16 层全注意力 + DeltaNet） |
| 草稿头 | 社区 ProCreations r3（Q4_0 量化，基础权重逐字节未改动） |

**它和官方基础模型的差别就是多了第 65 层 MTP 草稿块**。没有这块，`--spec-type draft-mtp` 用不了。
换成 r3 头后接受率从 **41–60%（社区 mtp-lean）升到 77–100%**，这是 MTP 划不划算的分水岭。

### 自己嫁接（可复现）

```bash
curl -L -x http://127.0.0.1:7897 -o model_mtp.safetensors \
  "https://hf-mirror.com/ProCreations/Ternary-Bonsai-2-27B-MTP/resolve/efffdea64c1f9e93cc7fa6bb24f72ae9d66ecf51/model_mtp.safetensors"
# 期望 SHA256: 7a4a18b2d02116ef184d1b0ee4af46d829825ff2c042f79cf37ef8a03c399218

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
  --spec-type draft-mtp --spec-draft-n-max 2 --spec-draft-depth-max 8192
```

### q4 KV：白拿 2× 上下文

q8 在 80K/96K 就掉到 5–7 t/s；q4 到 128K 仍不降速。

| ctx | q4_0 KV 的 tg @60K 深度 |
|---|---|
| 64K / 96K / 112K | 29.3 / 29.5 / 29.6 |
| **128K** | **29.5** |
| 160K | 21.9（掉速） |
| 192K | 装不下 |

模型原生 262144，但 12 GB 上 **128K 是可用上限**。

### ⚠ MTP 的收益取决于「ctx 分配大小」，不只是深度

这是本仓库最反直觉的一条，也是实际审计出来的：

**同一深度（20K）、同提示词、同接受率（77.6%），只改 `-c`：**

| ctx | 单 token 解码 | 一轮验证 | 一轮/单token | 净加速 |
|---|---|---|---|---|
| 65536 | 35.0 ms | **62.0 ms** | **1.76×** | **+45%** |
| 131072 | 34.7 ms | **96.7 ms** | **2.76×** | **−8%（更慢）** |

单 token 解码对 ctx 不敏感（都 ~35 ms），但**一轮验证在 128K ctx 下多花 35 ms**。
`[ASSUMED]` 机制推断：`self_kq_mask` 是 `[n_kv, n_batch]`，128K 时两倍大且每轮重建/拷贝，固定成本压在"每轮"上。

**所以「MTP 在所有深度都赢」只在 64K ctx 下成立。** 128K ctx 下的实际曲线：

| 工作深度 | t_single | t_round | 比值 | **净加速** |
|---|---|---|---|---|
| 1K | 31.42 ms | 52.17 ms | 1.66× | **1.52×** |
| 4K | 30.57 ms | 57.49 ms | 1.88× | **1.31×** |
| 8K | 31.80 ms | 67.23 ms | 2.11× | **1.21×** |
| 12K | 32.91 ms | 76.52 ms | 2.33× | **1.05×** |
| 20K | 35.09 ms | 96.67 ms | 2.76× | **0.92×** |

交叉点约 **15K**。这就是 `--spec-draft-depth-max 8192` 的依据：浅段吃收益，深处自动退回无投机
（实测 21K 提示 `draft_n=0`，草稿确实停了）。

### 已实测排除的旋钮（别重复做）

| 旋钮 | 结果 |
|---|---|
| `--spec-draft-n-max 3` / `4` | tg 38.9–46.4 / 37.0–45.4，接受率掉到 50% / 45%（n-max=2 是 48.8–49.6 / 65%） |
| `--spec-draft-p-min 0.5` | 接受率 65%→79%，但多做的那轮验证吃掉收益（45.8–47.7 < 48.8–49.6） |
| `--spec-type draft-mtp,ngram-mod` | 全新提示词下接受率**完全相同**（71.78%）、tg 还略慢（50.5 vs 51.5） |
| `--spec-draft-attn-window`（限草稿注意力窗） | 未实现；前置测量收益上限 <1%（草稿仅占 8.1%，其中 GPU decode 2.6%） |
| `-nkvo`（KV 放内存） | 能开 256K，但 tg 仅 7.2（PCIe 与显存带宽差 8.9×） |

> ngram 组合曾出现一次 116.3 t/s，是**同一提示词第二次请求命中 ngram 缓存**的假象，换新提示词即消失。

---

## 4. 生产链路

```
客户端 → :8081 kv-pager → :8080 llama-server
```

| 入口 | 用途 |
|---|---|
| `http://127.0.0.1:8081/v1` | **推荐**：页池复用 + 截断续写 + 用量/自检 |
| `http://127.0.0.1:8080/v1` | 直连本体（pager 挂了也不影响） |

模型 id `bonsai-27b`，**不需要 API key**（只绑回环）。启动：`scripts/serve.cmd`（不设守护进程）。

| 路径 | 作用 |
|---|---|
| `GET /pager/usage` | `n_ctx` / 预算 / 已用 / 剩余% / 槽位忙闲 |
| `GET /pager/selfcheck` | 跑固定任务量真实 tg，低于阈值告警（专治"能加载但只有 5 t/s"） |
| `POST /pager/save` | 存 KV 快照（约 450 MiB/份，默认不自动存） |

---

## 5. Agent 护栏（`agent-guards/`）

| 模块 | 作用 | 自测 |
|---|---|---|
| `edit-guard.mjs` | 单文件精确替换的**执行前校验** + 执行后验收 | 12/12 |
| `task-ledger.mjs` | 多动作任务的剩余动作账本 | 10/10 |
| `structured-feedback.mjs` | 工具失败回**结构化**反馈（码/可重试/下一步） | 18/18 |

零依赖纯 ESM，可当库用或当钩子进程用（`--stdin-json`，退出码表达 allow/deny）。

---

## 6. KV 页池（`kv-pager/`）

L0 实现：**前缀/轮次级** KV 快照复用（走 `slot save/restore`），不是 KV 页级。
真页级要改什么见 `kv-pager/PAGE-LEVEL-AUDIT.md`（L1 mask 选择 80–150 行但不提速 /
**L2 驻留窗口 450–850 行** / L3 内核 1000+ 行）。

`lib.mjs` 自测 20/20，`e2e.sh` 覆盖 passthrough / save / restored / compacted。

---

## 7. 明确的边界（不要外推）

1. 本 kit 只在 **Arc B580 + Windows + Vulkan** 上实测。
2. 128K 是「开 MTP + q4」的可用上限；**256K 装不下**，是 12 GB 的硬边界。
3. 长提示词 prefill 很慢：64K 一次约 **507 秒**（125 t/s），物理限制。
4. 真页级 KV 回迁未实现，只做了审计。
5. `response_format` / `json_schema` / `grammar` 上游都支持，但本 kit 没做默认注入。
6. 生态盘点：**只有 PrismML fork 有 Vulkan 三元内核**；BitNet.cpp / T-MAC 均无 GPU 路径；
   Intel 自己的 Xe2 2-bit 论文（arXiv 2508.06753，用 Bonsai 27B 评测、端到端最高 6.7×）**无公开代码**。
7. MTP 与 ctx 的耦合（见 §3）只在 ctx=65536 / 131072 两点验过，中间值未扫。

---


---

## 7.5 ⚠ 客户端输出空白（实测过，必读）

**症状**：在客户端（ZCode 等）发「你好」没有任何输出。

**根因**：GGUF 内嵌的 qwen35 聊天模板对 `reasoning_effort` 做白名单校验——

```jinja
{%- set resolved = reasoning_effort|default('xhigh') %}
{%- if resolved not in ('xhigh', 'medium', 'low') %}
{{- raise_exception('Unexpected reasoning effort ...') }}
```

客户端传 `high` / `minimal` 之类 → **模板抛异常 → HTTP 500 → 界面空白**。
服务端日志特征：`500 ... While executing CallExpression at line 49`。

**已修**：`kv-pager` 转发前把 `reasoning_effort` 映射进白名单
（`high→xhigh`、`minimal/none→low`），顶层同名字段直接丢弃；响应头 `x-kv-pager-notes` 会写 `remap-re=`。

⚠ **必须走 :8081**。直连 :8080 仍会 500 —— 这是模板行为，不是 server bug。

## 8. 与 llama.cpp 上游的关系

引擎侧改动（Vulkan 内核移植、`p=128` 偏移排除等）在 `port/torchit-vk` 分支与对应 Release 里。
本目录只放**配置、脚本、护栏、代理**这类与推理内核解耦的东西。
