# kv-pager — KV 页池 + 按相关性回迁

在 `llama-server` 前面加一层代理，把「长历史」和「小设备窗口」解耦：
**设备上下文固定 64K（快），历史存成 KV 快照（页池），请求进来按相关性挑一条回迁。**

## 先读这段：边界

| | 本实现 | KVMem（CUDA 参考实现） |
|---|---|---|
| 粒度 | **前缀 / 轮次** | **KV 页**（任意页拼注意力窗口） |
| 回迁方式 | llama-server `slot restore`（真是 KV，不是重新 prefill） | 每步按内容相关性挑页 H2D |
| 单份成本 | **整份 KV 落盘**（64K+q8 ≈ 2–3 GiB/份） | 只搬用到的页 |
| 需要改内核 | 否 | 是（KV 索引 + attention kernel） |

**为什么不做页级**：llama.cpp 的注意力把 KV 当**连续视图**（尤其开 FA 时），
任意页拼装要重做 KV 索引与 FA kernel，属千行级内核改动。
本实现在不改内核的前提下，拿到了「页池 + 相关性选择 + 真实 KV 回迁」的可用形态。

## 组成

```
ops/kv-pager/
  lib.mjs        纯逻辑：相关性打分 / 前缀匹配 / 预算裁剪（自测 20/20）
  kv-pager.mjs   HTTP 代理：页池索引 + restore + 转发
  e2e.sh         端到端验证（passthrough / save / restore / compaction）
  pool/          页池：index.json + raw/*.bin
```

## 跑起来

```bash
# 1) 上游必须开 slot 存取目录
llama-server.exe -m <model> -ngl 99 -c 65536 -ctk q8_0 -ctv q8_0 \
  --jinja --host 127.0.0.1 --port 8080 \
  --slot-save-path "<repo>/ops/kv-pager/pool/raw"

# 2) 起代理
cd ops/kv-pager
BUDGET_TOKENS=60000 PORT=8081 UPSTREAM=http://127.0.0.1:8080 node kv-pager.mjs

# 3) 客户端把 baseURL 指到 8081
```

环境变量：`UPSTREAM`（默认 8080）· `PORT`（8081）· `BUDGET_TOKENS`（60000）·
`POOL_DIR` · `AUTOSAVE_EVERY`（0=关闭自动存）· `SLOT`（0）。

## 三条路径（都实测过）

| 场景 | 行为 | 响应头 |
|---|---|---|
| 未超预算 | 原样转发；自动复用上游的 prompt cache | `x-kv-pager: passthrough` |
| 前缀命中页池 | `slot restore` 把真实 KV 装回槽位，然后转发 | `x-kv-pager: restored`，`notes: restored=<file>;reuseMsgs=N` |
| 超预算 | 按「与当前问题的相关性」裁剪中间轮次，**保证裁完不超预算** | `x-kv-pager: compacted`，`notes: dropped=N` |

裁剪规则（`lib.mjs: compactMessages`）：
1. 必留 第一条 system + 最后一条 user
2. 从最近往前贪心填
3. 剩余空档按相关性降序补
4. 单条就超预算 → 首尾保留式截断，**总量硬保证不超**
5. 有裁剪就插一条 `[kv-pager]` 系统提示，避免模型误以为历史本来就这么短

## 端到端实测（ctx 8192，2026-11-02）

```
1) 首问            x-kv-pager: passthrough
2) 存快照          {"ok":true,"name":"kvp-convA-4c9651e5746f-4.bin"}   473 MB
3) 同前缀再问      x-kv-pager: restored  notes: restored=...;reuseMsgs=4
4) 超预算          x-kv-pager: compacted notes: dropped=1   （6800 字符填充段被丢）
stats: {"requests":3,"restored":1,"compacted":1,"saved":1}
```

## 成本警告（实测数字，修正过一次）

`slot save` 是**整份 KV 落盘**，实测：

| 设备上下文 | 单份快照 | 备注 |
|---|---|---|
| 8K（e2e） | **472,116,468 B ≈ 450 MiB** | 只用了 ~30 token |
| 128K（生产链路） | **472,116,468 B ≈ 450 MiB** | 只用了 ~20 token |

**两次几乎一样大** —— 说明 dump 的体积**不随 ctx 线性增长**，更像是按分配到的 buffer 块走。
但无论如何它是 **~450 MiB/份**，不是零成本：

- 池子硬限 3 份（≈1.4 GiB）
- **默认不自动存**（`AUTOSAVE_EVERY=0`）
- 要显式存就用 `POST /pager/save`，在会话锚点（长文档读完、任务阶段切换）存一次

这正是 KVMem 用「页池」而不是「整份 dump」的原因 —— 见 `PAGE-LEVEL-AUDIT.md`。

## HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/v1/chat/completions` | 主路径（支持 stream 透传） |
| POST | `/pager/save` | 手动存快照，body 同 chat（用其中 messages） |
| GET | `/pager/stats` | 计数 + 池目录 |
| GET | **`/pager/usage`** | 上下文用量：`n_ctx` / 预算 / 已用 / 剩余% / 槽位是否忙 |
| GET | **`/pager/selfcheck`** | 降速自检：跑固定任务量真实 tg，低于阈值返回告警（`?force=1` 跳过缓存） |
| POST | `/pager/erase` | 清槽位 |
| * | 其它 | 原样透传（`/v1/models` `/health` `/tokenize` …） |

## 三个体验功能（2026-11-02 加）

### 1. 截断自动续写 `AUTO_CONTINUE`（默认 1）

本地 27B 写长输出必断。上游返回 `finish_reason=length` 时，pager 自动带「继续从中断处写、不重复」再请求一轮并合并，响应头给出 `x-kv-pager-continued: N`。

实测：`max_tokens=40` 逼它截断 → 头 `continued: 1`，内容接上了、编号没重复。
`AUTO_CONTINUE=0` 关闭；只对非流式生效（流式无法安全合并）。

### 2. 降速自检 `/pager/selfcheck`

针对我们真实踩过的坑：**ctx 开太大时服务"能加载、日志正常，但 tg 掉到 5–22"**。

- 启动后 10 秒自动跑一次（`SELFCHECK_ON_START=0` 关闭）
- 跑固定任务（LRU 代码题 + 200 token），读上游 `timings` 算真实 tg
- 低于 `SELFCHECK_MIN_TG`（默认 25）→ `ok:false` + 给出建议（降 ctx / 降 KV 精度）
- 结果缓存 10 分钟（`SELFCHECK_TTL_MS`）

实测：启动自检 `tg=50` 通过；强制重跑 `tg=49.4`，4.4 秒。

### 3. 上下文用量 `/pager/usage`

直接透上游 `/slots` + `/props`，告诉调用方"还能聊多久"：

```json
{ "n_ctx": 131072, "budget_tokens": 120000, "slot_used_tokens": 280,
  "slot_busy": false, "remaining_pct": 99.8, "speculative": true, "model": "bonsai-27b" }
```

## 守护（`_tmp/.../supervise.sh`）

服务进程本轮消失过 ≥4 次且日志无报错，所以加了守护：

- llama-server 或 pager 挂掉 → 自动重启，退避 5/10/30/60 秒
- 服务端重启时 pager 跟着重启（槽位状态已丢，池索引失效）
- 连续 3 次起不来 → 写 `SUPERVISE-ALERT.txt` 并退出（不无限重启）
- **不做开机自启**（用户明确不要）

实测：`taskkill` 掉 llama-server 后 **10 秒恢复**，pid 从 13176 换成 14236。

⚠ 日志文件必须分开写：`serve.cmd` → `supervisor.out`，守护 → `supervise.log`，
llama-server → `server.log`，pager → `pager.log`。
（三个进程抢写同一个文件在 Windows 上直接 `Device or resource busy`，服务起不来。）

## 自测

```bash
node lib.mjs --selftest        # 20/20：词元/重合度/LCP/页池排序/预算裁剪/截断/命名
PG=8083 bash e2e.sh            # 端到端四条路径（会临时占用 8080/8083，跑完清理）
```

⚠ `e2e.sh` 的清场必须按**命令行**杀 node：Git Bash 的 `pkill` 匹配不到 Windows 进程，
残留进程会占着端口、带着旧内存状态应答，让整轮测试变成假绿（已踩过，脚本里加了端口占用硬检查）。

## 和 KVMem 的差距（诚实版）

拿不到的：**每步按内容挑页**、**页级稀疏注意力**、**只搬用到的页**。
所以 KVMem 能用 12,800 token 的设备池跑 256K 逻辑上下文而只掉一点速，
我们这套只能做到「64K 设备窗口 + 多前缀快照复用」——**换问句很便宜，单请求超 64K 仍然要裁剪**。

要真正补齐，需要实现一个 `llama_memory_context` 子类，把逻辑位置映射到物理页并在 mask 里表达，
同时给 FA kernel 加「非连续 KV 页」的索引。那是内核级工程，不是配置能解决的。
