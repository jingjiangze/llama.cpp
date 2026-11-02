# agent-guards — 用 harness 补模型的三件套

来源：`CSUNX233/qwen3.8-27b-ninfer-...` v1.0.0 的 agent 执行层经验（Apache-2.0）。
**这三条与显卡、与推理引擎都无关**——它们是「让 27B 本地模型能可靠跑多步文件任务」的 harness 逻辑，
所以 B580 + Vulkan 上一样能用（也适用于云端模型驱动工具的场景）。

零依赖，纯 ESM，Node ≥ 18。

---

## 1. `edit-guard.mjs` — 执行前校验，把错误动作拦在落盘前

**解决什么**：模型说「已修改」，实际没改 / 改错位置 / 静默换路径 / old 命中多处只替了一处。

**介入条件**（三个都满足才动手）：
1. 最新指令里有精确替换意图（`只改` / `仅修改` / `唯一` / `only change` / `exactly once` …）
2. 指令里明确的文件路径 ≤ 1 个（≥2 个视为多文件任务，自动让路）
3. 会话里有该文件的**读取证据**

**校验内容**：目标存在 → `old` 在文件里**恰好命中 1 处** → `old != new`。任一不满足就 `deny`，
并把「目标 / old / new / 命中数 / 下一步」回传。**绝不改写调用方参数、绝不静默替换路径。**

执行完再用真实文件内容做一次验收（`new` 在、`old` 不在）。

```bash
# 执行前
echo '{"phase":"pre","instruction":"只改 a.mjs 里那一行","target":"a.mjs",
       "old":"原字符串","new":"新字符串","session_reads":["a.mjs"]}' \
  | node edit-guard.mjs --stdin-json
# → {"decision":"allow","code":"pre_ok",...}   退出码 0
# → {"decision":"deny","code":"old_ambiguous","details":{"occurrences":2,"hint":"..."}}  退出码 1

# 执行后验收
echo '{"phase":"post","target":"a.mjs","old":"原字符串","new":"新字符串"}' \
  | node edit-guard.mjs --stdin-json
```

deny 码：`no_read_evidence` / `target_missing` / `old_not_found` / `old_ambiguous` /
`no_change` / `empty_old` / `post_new_missing` / `post_old_remains`。
skip 码：`multi_file_bypass` / `no_exact_intent`。

---

## 2. `task-ledger.mjs` — 多动作任务的剩余动作账本

**解决什么**：指令里三个动作（move + edit + write），模型干完一个就想收工。

**做法**：解析最新指令里的 move / edit / write 动作 → 用**成功的**工具结果标记完成 →
agent 想停时若还有未完成动作，产出结构化提醒。**不执行工具、不改写参数、不自动补写。**

```bash
echo '{"instruction":"先改 a.txt 的常量，然后新建 c.md 写说明",
       "results":[{"tool":"edit_file","path":"a.txt","ok":true}]}' \
  | node task-ledger.mjs --stdin-json
# → {"total":2,"done":1,"remaining":[{"kind":"write","path":"c.md"}],
#    "reminder":{"code":"remaining_actions","count":1,
#                "message":"指令里还有 1 个动作没完成，不要现在停下：\n1. write c.md"}}
```

注意：`ok:false` 的结果**不算完成**（自测覆盖）；分句支持中文逗号/顿号/句号/换行 +
`然后/接着/最后/并且/同时` 连接词。

---

## 3. `structured-feedback.mjs` — 把工具失败回传成结构化反馈

**解决什么**：只回「出错了」，模型只能瞎猜或原地重试。
v1.0.0 的实测是：结构化反馈后一次恢复 **10/10**，自由文本 **0/10**。

**四件事必须齐**：在哪失败 / 失败码 / 是否可重试 / **下一步具体做什么**（不能是「请重试」）。

```bash
echo '{"tool":"edit_file","target":"a.mjs","error":"old 在文件里命中 2 处，不唯一"}' \
  | node structured-feedback.mjs --stdin-json --text
```
输出（回灌给模型的块，格式确定、可 diff）：
```
<<TOOL_ERROR>>
tool: edit_file
target: a.mjs
code: EDIT_OLD_AMBIGUOUS
retryable: yes
hint: old 命中多处，不唯一
next_action: 把 old 扩展到能唯一定位的上下文，或改用行范围替换
detail: |
  old 在文件里命中 2 处，不唯一
<</TOOL_ERROR>>
```

已覆盖分类：`ENOENT` / `EACCES` / `EPERM` / `EISDIR` / `ENOSPC` / `EBUSY` / `ETIMEDOUT` /
`ECONNRESET` / `JSON_PARSE` / `TRUNCATED` / `EXIT_CODE` / `EDIT_OLD_NOT_FOUND` /
`EDIT_OLD_AMBIGUOUS` / `EDIT_NO_READ_EVIDENCE` / `EDIT_NO_CHANGE` / `UNKNOWN`。
中英文错误文本都能分类。

---

## 4. 第四条（无需新代码，已经生效）

v1.0.0 记录：500 行编号输出在 `max_tokens=12288` 下失败，**根因是 xhigh reasoning 吃掉预算，
不是序列 bug**。我们已经在用 `--reasoning-budget 0` 跑本地服务，这条已落实。

---

## 自测

```bash
node edit-guard.mjs --selftest            # 12/12
node task-ledger.mjs --selftest           # 10/10
node structured-feedback.mjs --selftest   # 18/18
```

判定依据都写在断言名里（如「old 不唯一→deny」「失败的工具不算完成」），可直接对照。

---

## 怎么接进现有流程

这三个都是「纯函数 + CLI」，两种接法：

1. **当库用**（推荐）：`import { checkPre, checkPost } from './edit-guard.mjs'`，
   在你自己的工具执行前后各调一次。
2. **当钩子进程用**：`--stdin-json` 读 payload、写 JSON、用退出码表达 allow/deny
   （`0` = 允许，`1` = 拒绝），任何能执行子进程的 agent runtime 都能挂。

⚠ 本工作区的 hook 已全局停用（见 `AGENTS.md` §3），所以**目前是库/CLI 形态，不自动触发**；
要真正"执行前拦截"，需要宿主提供 tool-call 前置钩子。

## 与 v1.0.0 的边界一致

我们不宣称这三件能提升模型能力。它们只做两件事：**把错误拦在落盘前**、**把失败变成可行动的信息**。
真正的推理能力仍然是模型自己的；v1.0.0 里那个 1/4→4/4 的长历史召回提升来自引擎层查询开关，
llama.cpp 没有对应物，这三件套复现不了。
