// kv-pager：在 llama-server 前面做「KV 页池 + 按相关性回迁」
//
// 它做三件事：
//   1. 页池：把会话前缀的 KV 存成快照（llama-server 的 slot save），按内容前缀建索引
//   2. 回迁：新请求进来时，先按「与池中快照的公共前缀」挑最省的一条 restore，再转发
//   3. 预算：仍然超窗时，按「与当前问题的相关性」裁剪中间轮次（首尾必留）
//
// ⚠ 边界（不要误解）
//   - 粒度是「前缀/轮次」，不是 KV 页。真正的页级回迁要重做 attention 的 KV 索引与 FA 内核。
//   - slot save 是**整份 KV 落盘**（64K + q8 ≈ 2.1 GiB/次），所以池子是"粗粒度锚点"，
//     默认不自动存（AUTOSAVE_EVERY=0），需要显式 POST /pager/save 或调大间隔。
//
// 启动：
//   llama-server.exe ... --slot-save-path <POOL_DIR>/raw --port 8080
//   node kv-pager.mjs                       # 监听 8081，转发到 8080
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { rankSnapshots as _unused, shouldRestore, compactMessages, snapshotName, MIN_REUSE_TOKENS } from './lib.mjs';

const UPSTREAM = process.env.UPSTREAM || 'http://127.0.0.1:8080';
const PORT = Number(process.env.PORT || 8081);
const BUDGET_TOKENS = Number(process.env.BUDGET_TOKENS || 60000);
const POOL_DIR = process.env.POOL_DIR || path.join(process.cwd(), 'pool');
const RAW_DIR = path.join(POOL_DIR, 'raw');
const INDEX_FILE = path.join(POOL_DIR, 'index.json');
const AUTOSAVE_EVERY = Number(process.env.AUTOSAVE_EVERY || 0); // 0 = 关闭自动存
const SAVE_MIN_GROWTH = Number(process.env.SAVE_MIN_GROWTH || 4000); // 字符数增长阈值
const SLOT = Number(process.env.SLOT || 0);

// 截断自动续写：上游返回 finish_reason=length 时，自动续写最多 N 轮再合并
const AUTO_CONTINUE = Number(process.env.AUTO_CONTINUE ?? 1);
const CONTINUE_HINT = process.env.CONTINUE_HINT
    || '继续从中断处往下写，直接接续，不要重复已经写过的内容，不要重新开头。';

// 降速自检：固定任务测 tg，低于阈值就是"能加载但不可用"
const SELFCHECK_MIN_TG = Number(process.env.SELFCHECK_MIN_TG || 25);
const SELFCHECK_MAXTOK = Number(process.env.SELFCHECK_MAXTOK || 200);
const SELFCHECK_PROMPT = 'Write a Python class implementing a thread-safe LRU cache with get, put, and eviction. '
    + 'Include type hints and docstrings for every method.';
const SELFCHECK_TTL_MS = Number(process.env.SELFCHECK_TTL_MS || 600000); // 10 分钟
const selfcheck = { last: null, at: 0, running: false };

fs.mkdirSync(RAW_DIR, { recursive: true });

// ---------- 页池索引 ----------
// 每条：{ name, convId, msgCount, prefixHashes:[...], chars, savedAt }
let index = [];
try {
    index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
} catch { index = []; }

const saveIndex = () => fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

// 逐条消息滚动哈希链：第 k 项 = hash(前 k 条消息)，便于「最长公共前缀」判定
function prefixChain(messages) {
    let h = crypto.createHash('sha1');
    const out = [];
    for (const m of messages) {
        h = crypto.createHash('sha1').update(h.digest('hex')).update(String(m.role)).update('\u0000').update(String(m.content));
        out.push(h.copy().digest('hex'));
    }
    return out;
}

function commonPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
}

function bestSnapshot(chain, convId) {
    let best = null;
    for (const e of index) {
        if (convId && e.convId !== convId) continue;
        const k = commonPrefix(chain, e.prefixHashes || []);
        if (k > 0 && (!best || k > best.k)) best = { ...e, k };
    }
    return best;
}

// ---------- 与上游交互 ----------
async function upstreamJson(pathname, body) {
    const r = await fetch(UPSTREAM + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 保持原样 */ }
    return { status: r.status, text, json };
}

async function slotAction(action, filename) {
    return upstreamJson(`/slots/${SLOT}?action=${action}`, { filename });
}

async function fetchSlots() {
    try {
        const r = await fetch(UPSTREAM + '/slots');
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

async function fetchProps() {
    try {
        const r = await fetch(UPSTREAM + '/props');
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

// 降速自检：跑一次固定任务，量真实的 tg
// 这是针对我们踩过的坑——ctx 开太大时"能加载、日志正常，但 tg 掉到 5–22"
async function runSelfcheck() {
    if (selfcheck.running) return selfcheck.last;
    selfcheck.running = true;
    const t0 = Date.now();
    try {
        const body = {
            messages: [{ role: 'user', content: SELFCHECK_PROMPT }],
            temperature: 0, max_tokens: SELFCHECK_MAXTOK,
        };
        const r = await fetch(UPSTREAM + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
        const j = await r.json();
        const t = j?.timings || {};
        const tg = Number(t.predicted_per_second || 0);
        const pp = Number(t.prompt_per_second || 0);
        const toks = Number(t.predicted_n || 0);
        const ok = r.status === 200 && toks > 0 && tg >= SELFCHECK_MIN_TG;
        selfcheck.last = {
            ok,
            tg: Number(tg.toFixed(1)),
            pp: Number(pp.toFixed(1)),
            tokens: toks,
            threshold: SELFCHECK_MIN_TG,
            wallMs: Date.now() - t0,
            at: new Date().toISOString(),
            advice: ok
                ? null
                : '吞吐低于阈值：不是"模型慢"，多半是 ctx 开太大把显存挤爆（实测 96K/160K 都能加载但只有 5–22 t/s）。'
                  + '把 CTX 降到实测不降速的档位（当前最优 131072 + q4_0），或把 KV 精度降到 q4_0。',
        };
    } catch (e) {
        selfcheck.last = { ok: false, error: String(e?.message || e), at: new Date().toISOString() };
    } finally {
        selfcheck.running = false;
        selfcheck.at = Date.now();
    }
    return selfcheck.last;
}

// 截断自动续写：把 finish_reason=length 的响应补完
async function continueIfTruncated(outBody, respJson) {
    const ch0 = respJson?.choices?.[0];
    if (!ch0 || ch0.finish_reason !== 'length') return { json: respJson, rounds: 0 };
    if (AUTO_CONTINUE <= 0) return { json: respJson, rounds: 0 };

    let content = String(ch0.message?.content ?? '');
    let rounds = 0;
    const messages = [...outBody.messages];

    while (rounds < AUTO_CONTINUE) {
        rounds++;
        const follow = {
            ...outBody,
            messages: [
                ...messages,
                { role: 'assistant', content },
                { role: 'user', content: CONTINUE_HINT },
            ],
        };
        let j;
        try {
            const r = await fetch(UPSTREAM + '/v1/chat/completions', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(follow),
            });
            j = await r.json();
        } catch { break; }
        const c = j?.choices?.[0];
        const add = String(c?.message?.content ?? '');
        if (!add) break;
        content += add;
        if (c?.finish_reason !== 'length') break;
    }

    // 合并回原响应，保持字段结构不变
    const merged = JSON.parse(JSON.stringify(respJson));
    merged.choices[0].message.content = content;
    if (merged.usage) merged.usage.completion_tokens = (merged.usage.completion_tokens || 0);
    return { json: merged, rounds };
}

// ---------- 粗估 token（中英混排） ----------
// 只用于「是否超预算」的判断，不参与精确计费；宁可高估
function estimateTokens(messages) {
    let chars = 0;
    for (const m of messages || []) chars += String(m?.content ?? '').length;
    return Math.ceil(chars / 3.0);
}

const stats = { requests: 0, restored: 0, compacted: 0, saved: 0, passthrough: 0, sinceSave: 0, continued: 0, selfchecks: 0 };

// ---------- 主处理 ----------
async function handleChat(reqBody, res) {
    const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : [];
    const convId = String(reqBody?.user || reqBody?.conversation_id || reqBody?.metadata?.conversation_id || 'default');
    const est = estimateTokens(messages);

    const chain = prefixChain(messages);
    let action = 'passthrough';
    let restoreName = null;
    let outBody = { ...reqBody, messages };
    const notes = [];

    // 1) 先把明显超窗的处理掉（相关性裁剪）
    if (est > BUDGET_TOKENS) {
        const budgetChars = Math.floor(BUDGET_TOKENS * 3.0);
        const c = compactMessages(messages, { budgetChars, headKeep: 2, tailKeep: 6 });
        outBody.messages = c.messages;
        action = 'compacted';
        notes.push(`dropped=${c.dropped}`, `keptRelevant=${c.keptRelevant}`);
        stats.compacted++;
    }

    // 2) 再看页池里有没有值得回迁的前缀（回迁能让 prefill 复用真实 KV）
    const best = bestSnapshot(chain, convId);
    if (best && best.k >= 4 && best.k >= Math.min(messages.length - 1, MIN_REUSE_TOKENS / 512)) {
        const r = await slotAction('restore', best.name);
        if (r.status === 200) {
            restoreName = best.name;
            notes.push(`restored=${best.name}`, `reuseMsgs=${best.k}`);
            stats.restored++;
            if (action === 'passthrough') action = 'restored';
        } else {
            notes.push(`restore_failed=${r.status}`);
        }
    }

    // 3) 转发
    const r = await fetch(UPSTREAM + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(outBody),
    });

    // 流式直接管道回传
    const isStream = r.headers.get('content-type')?.includes('text/event-stream');
    if (isStream) {
        res.writeHead(r.status, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'x-kv-pager': action,
            'x-kv-pager-notes': notes.join(';'),
            'x-kv-pager-est-tokens': String(est),
        });
        for await (const chunk of r.body) res.write(chunk);
        res.end();
    } else {
        const text = await r.text();
        let payload = text;
        let continued = 0;
        // finish_reason=length → 自动续写并合并（本地 27B 写长输出必断）
        if (r.status === 200 && AUTO_CONTINUE > 0) {
            try {
                const parsed = JSON.parse(text);
                const out = await continueIfTruncated(outBody, parsed);
                if (out.rounds > 0) {
                    payload = JSON.stringify(out.json);
                    continued = out.rounds;
                    stats.continued++;
                }
            } catch { /* 非 JSON 或结构异常：原样返回 */ }
        }
        res.writeHead(r.status, {
            'content-type': 'application/json; charset=utf-8',
            'x-kv-pager': action,
            'x-kv-pager-notes': notes.join(';'),
            'x-kv-pager-est-tokens': String(est),
            'x-kv-pager-continued': String(continued),
        });
        res.end(payload);
    }

    // 4) 按需存快照（整份 KV 落盘，很贵，默认关）
    stats.sinceSave++;
    if (AUTOSAVE_EVERY > 0 && stats.sinceSave >= AUTOSAVE_EVERY) {
        stats.sinceSave = 0;
        await saveSnapshot(messages, convId, chain);
    }
}

async function saveSnapshot(messages, convId, chain) {
    // 已存在同样前缀就不重复存
    if (index.some((e) => e.prefixHashes?.length === chain.length && e.convId === convId &&
        e.prefixHashes[chain.length - 1] === chain[chain.length - 1])) {
        return { skipped: true };
    }
    const hash = chain[chain.length - 1] || 'empty';
    const name = snapshotName(convId, hash, messages.length);
    const r = await slotAction('save', name);
    if (r.status !== 200) return { ok: false, status: r.status, body: r.text.slice(0, 200) };

    index.push({
        name,
        convId,
        msgCount: messages.length,
        prefixHashes: chain,
        chars: messages.reduce((n, m) => n + String(m?.content ?? '').length, 0),
        savedAt: Date.now(),
    });
    // 池子只留最近 3 条，避免盘上堆几百 GiB
    while (index.length > 3) {
        const old = index.shift();
        try { fs.unlinkSync(path.join(RAW_DIR, old.name)); } catch { /* 已不在 */ }
    }
    saveIndex();
    stats.saved++;
    return { ok: true, name };
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    try {
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
            const body = await readJson(req);
            stats.requests++;
            return await handleChat(body, res);
        }
        if (req.method === 'POST' && url.pathname === '/pager/save') {
            const body = await readJson(req);
            const messages = Array.isArray(body?.messages) ? body.messages : [];
            const convId = String(body?.user || 'default');
            const out = await saveSnapshot(messages, convId, prefixChain(messages));
            res.writeHead(out.ok ? 200 : 500, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(out));
        }
        if (req.method === 'GET' && url.pathname === '/pager/stats') {
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ stats, pool: index.map((e) => ({ name: e.name, convId: e.convId, msgCount: e.msgCount, chars: e.chars, savedAt: e.savedAt })), config: { UPSTREAM, BUDGET_TOKENS, AUTOSAVE_EVERY, SLOT, AUTO_CONTINUE, SELFCHECK_MIN_TG } }, null, 2));
        }
        // 上下文用量：直接问上游 slots/props，给调用方"还能聊多久"
        if (req.method === 'GET' && url.pathname === '/pager/usage') {
            const [slots, props] = await Promise.all([fetchSlots(), fetchProps()]);
            const s = Array.isArray(slots) ? slots[SLOT] : null;
            const nCtx = s?.n_ctx ?? props?.default_generation_settings?.n_ctx ?? null;
            const used = s?.n_prompt_tokens ?? null;
            const out = {
                n_ctx: nCtx,
                budget_tokens: BUDGET_TOKENS,
                slot_used_tokens: used,
                slot_busy: s?.is_processing ?? null,
                speculative: s?.speculative ?? null,
                remaining_pct: (nCtx && used != null) ? Number((100 * (1 - used / nCtx)).toFixed(1)) : null,
                model: props?.model_alias ?? null,
            };
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify(out, null, 2));
        }
        // 降速自检：低于阈值 = "能加载但不可用"
        if (req.method === 'GET' && url.pathname === '/pager/selfcheck') {
            const force = url.searchParams.get('force') === '1';
            const fresh = selfcheck.last && (Date.now() - selfcheck.at) < SELFCHECK_TTL_MS;
            const result = (fresh && !force) ? selfcheck.last : await runSelfcheck();
            if (!fresh || force) stats.selfchecks++;
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ cached: fresh && !force, ...result }, null, 2));
        }
        if (req.method === 'POST' && url.pathname === '/pager/erase') {
            const r = await slotAction('erase');
            res.writeHead(r.status, { 'content-type': 'application/json' });
            return res.end(r.text);
        }
        // 其它路径一律透传（/v1/models、/health、/tokenize …）
        const r = await proxyRaw(req, url);
        res.writeHead(r.status, Object.fromEntries(r.headers));
        return res.end(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
});

function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (d) => { raw += d; });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

async function proxyRaw(req, url) {
    const init = { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json' } };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await new Promise((resolve) => {
        const bufs = [];
        req.on('data', (d) => bufs.push(d));
        req.on('end', () => resolve(Buffer.concat(bufs)));
    });
    return fetch(UPSTREAM + url.pathname + url.search, init);
}

server.listen(PORT, '127.0.0.1', () => {
    console.log(`kv-pager 监听 http://127.0.0.1:${PORT}  ->  ${UPSTREAM}`);
    console.log(`预算 ${BUDGET_TOKENS} tok | 槽位 ${SLOT} | 池 ${POOL_DIR} | 自动存 每 ${AUTOSAVE_EVERY || '关'} 次 | 续写 ${AUTO_CONTINUE} 轮`);
    // 启动自检：延迟 10 秒（等上游把首轮 graph 预热完），不阻塞监听
    if (process.env.SELFCHECK_ON_START !== '0') {
        setTimeout(() => {
            runSelfcheck().then((r) => {
                if (r?.ok) {
                    console.log(`[selfcheck] 启动自检通过: tg=${r.tg} t/s pp=${r.pp} tok=${r.tokens}`);
                } else {
                    console.log(`[selfcheck] ⚠ 启动自检不通过: ${JSON.stringify(r)}`);
                }
            });
        }, 10000);
    }
});
