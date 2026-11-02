// kv-pager 纯逻辑层：页池选择 + 相关性打分 + 预算裁剪
//
// 边界（必须写清）：本模块做的是**前缀/轮次粒度**的 KV 回迁。
// 真正的「KV 页级回迁」（任意页拼装注意力窗口）需要重做 attention 的 KV 索引与 FA 内核，
// 不在本模块范围内；这里利用 llama-server 的 slot save/restore（KV 是真的，不是重新 prefill）。
//
// 自测：node lib.mjs --selftest
import process from 'node:process';

// ---------- 文本 → 可比较的词元 ----------
// 中英混排：英文按词、中文按 2-gram 字符，避免对中文完全失效
export function lexTokens(text) {
    const s = String(text || '').toLowerCase();
    const out = new Set();
    for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) out.add(m[0]);
    const cjk = s.replace(/[^\u4e00-\u9fff]/g, '');
    for (let i = 0; i + 1 < cjk.length; i++) out.add(cjk.slice(i, i + 2));
    return out;
}

// 词元集合的加权重合度（|A∩B| / sqrt(|A|·|B|)），对长度不敏
export function overlap(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / Math.sqrt(a.size * b.size);
}

// ---------- 公共前缀长度（按 token id 序列） ----------
export function lcpLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
}

// ---------- 页池候选打分 ----------
// 候选 = { name, tokens:[id...], turns:[{roles,摘要}] }
// 入参 promptTokens = 本次请求的完整 token 序列
// 返回按「可直接复用多少 token」排序的候选
export function rankSnapshots(snapshots, promptTokens) {
    return (snapshots || [])
        .map((s) => ({ ...s, lcp: lcpLen(s.tokens || [], promptTokens) }))
        .filter((s) => s.lcp > 0)
        .sort((x, y) => y.lcp - x.lcp || (y.savedAt || 0) - (x.savedAt || 0));
}

// 命中阈值：至少能省下这么多 token 的 prefill 才值得 restore
export const MIN_REUSE_TOKENS = 1024;

export function shouldRestore(ranked, minReuse = MIN_REUSE_TOKENS) {
    return ranked.length > 0 && ranked[0].lcp >= minReuse ? ranked[0] : null;
}

// ---------- 预算裁剪（超窗口时的相关性选择） ----------
// 原则：**以预算为准**，不以保证条数为准。
//   1. 永远保留 第一条 system（若有）+ 最后一条 user（当前问题）
//   2. 从最近往前贪心填充，装不下就停
//   3. 剩下的空档按「与最后一条 user 的相关性」降序补
//   4. 单条就超预算时，对它的文本做首尾保留式截断，保证总量不超
// 返回 { messages, dropped, keptRelevant, truncated, compacted }
export function compactMessages(messages, { budgetChars = 150000, headKeep = 2, tailKeep = 6, relevanceFloor = 0.06 } = {}) {
    const msgs = Array.isArray(messages) ? messages : [];
    const len = (m) => String(m?.content ?? '').length;
    const total = msgs.reduce((n, m) => n + len(m), 0);
    if (total <= budgetChars) {
        return { messages: msgs, dropped: 0, keptRelevant: 0, truncated: 0, compacted: false };
    }

    const n = msgs.length;
    const lastUserIdx = (() => {
        for (let i = n - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return i;
        return n - 1;
    })();
    const firstSystemIdx = msgs.findIndex((m) => m?.role === 'system');

    const picked = new Map(); // idx -> message（可能被截断）
    let room = budgetChars;

    // 1) 必留：system + 当前问题
    for (const idx of [firstSystemIdx, lastUserIdx]) {
        if (idx < 0 || picked.has(idx)) continue;
        let m = msgs[idx];
        let L = len(m);
        if (L > room) {
            // 单条就超预算：截断保头尾
            const keepEach = Math.max(200, Math.floor(room / 2) - 60);
            const c = String(m.content ?? '');
            m = { ...m, content: c.slice(0, keepEach) + '\n…[kv-pager 截断]…\n' + c.slice(-keepEach) };
            L = len(m);
        }
        picked.set(idx, m);
        room -= L;
    }

    const qtok = lexTokens(msgs[lastUserIdx]?.content);

    // 2) 从最近往前填（跳过已选）
    for (let i = n - 1; i >= 0 && room > 0; i--) {
        if (picked.has(i)) continue;
        const L = len(msgs[i]);
        if (L > room) continue;
        picked.set(i, msgs[i]);
        room -= L;
    }

    // 3) 相关性补洞
    const scored = msgs
        .map((m, i) => ({ i, s: overlap(lexTokens(m?.content), qtok), L: len(m) }))
        .filter((x) => !picked.has(x.i) && x.s >= relevanceFloor && x.L <= room)
        .sort((a, b) => b.s - a.s || b.i - a.i);
    let keptRelevant = 0;
    for (const x of scored) {
        if (picked.has(x.i)) continue;
        if (x.L > room) continue;
        picked.set(x.i, msgs[x.i]);
        room -= x.L;
        keptRelevant++;
    }

    // 4) 兜底：仍超预算就砍最长的非必留项
    const mustKeep = new Set([firstSystemIdx, lastUserIdx].filter((i) => i >= 0));
    while (budgetChars - (budgetChars - room) > budgetChars) { break; } // no-op 保护
    let used = [...picked.values()].reduce((k, m) => k + len(m), 0);
    if (used > budgetChars) {
        const candidates = [...picked.keys()].filter((i) => !mustKeep.has(i)).sort((a, b) => len(picked.get(b)) - len(picked.get(a)));
        for (const i of candidates) {
            if (used <= budgetChars) break;
            used -= len(picked.get(i));
            picked.delete(i);
        }
    }

    const keptIdx = [...picked.keys()].sort((a, b) => a - b);
    const dropped = n - keptIdx.length;
    const truncated = [...picked.values()].filter((m) => String(m.content ?? '').includes('[kv-pager 截断]')).length;

    const marker = (dropped > 0 || truncated > 0)
        ? [{ role: 'system', content: `[kv-pager] 为适配上下文窗口，已省略 ${dropped} 条较早的中间消息${truncated ? `，并对 ${truncated} 条超长消息做了首尾截断` : ''}；当前问题与开头约束已保留。` }]
        : [];

    const out = keptIdx.map((i) => picked.get(i));
    // 把 marker 插在第一条 system 之后（没有 system 就放最前）
    const outMsgs = firstSystemIdx >= 0 && keptIdx[0] === firstSystemIdx
        ? [out[0], ...marker, ...out.slice(1)]
        : [...marker, ...out];

    return {
        messages: outMsgs,
        dropped,
        keptRelevant,
        truncated,
        compacted: dropped > 0 || truncated > 0,
        chars: outMsgs.reduce((k, m) => k + len(m), 0),
    };
}

// ---------- 快照命名（防冲突、便于人读） ----------
export function snapshotName(convId, prefixHash, lcp) {
    const c = String(convId || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'default';
    return `kvp-${c}-${String(prefixHash).slice(0, 12)}-${String(lcp)}.bin`;
}

// ---------- 自测 ----------
function selftest() {
    const R = [];
    const t = (name, got, want) => R.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

    // 词元与重合度
    t('英文词元', [...lexTokens('Hello world hello')].sort(), ['hello', 'world']);
    t('中文 2-gram 生效', [...lexTokens('上下文窗口')].length, 4);
    t('无重合→0', overlap(lexTokens('alpha beta'), lexTokens('gamma delta')), 0);
    t('完全重合→1', overlap(lexTokens('alpha beta'), lexTokens('alpha beta')), 1);

    // 公共前缀
    t('LCP 基本', lcpLen([1, 2, 3, 9], [1, 2, 3, 4]), 3);
    t('LCP 全同', lcpLen([1, 2], [1, 2]), 2);
    t('LCP 无交集', lcpLen([1, 2], [3, 4]), 0);

    // 页池排序
    const snaps = [
        { name: 'a', tokens: [1, 2, 3], savedAt: 1 },
        { name: 'b', tokens: [1, 2, 3, 4, 5], savedAt: 2 },
        { name: 'c', tokens: [9, 9], savedAt: 3 },
    ];
    const ranked = rankSnapshots(snaps, [1, 2, 3, 4, 5, 6]);
    t('页池按 LCP 排序', ranked.map((r) => r.name), ['b', 'a']);
    t('LCP 最大的入选', shouldRestore(ranked, 3).name, 'b');
    t('低于阈值不 restore', shouldRestore(ranked, 10), null);

    // 预算裁剪
    const big = 'x'.repeat(40000);
    const msgs = [
        { role: 'system', content: 'S' },
        { role: 'user', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: big },
        { role: 'assistant', content: big },
        { role: 'user', content: '最后的提问：部署脚本路径是什么' },
    ];
    const c = compactMessages(msgs, { budgetChars: 100000, headKeep: 1, tailKeep: 2 });
    t('超预算会裁剪', c.compacted, true);
    t('裁剪后必在预算内', c.chars <= 100000, true);
    t('保留了最后一条用户消息', c.messages[c.messages.length - 1].content.includes('部署脚本'), true);
    t('插入了省略标记', c.messages.some((m) => String(m.content).includes('[kv-pager]')), true);

    // 单条就超预算：必须截断，且总量不超
    const one = compactMessages([{ role: 'user', content: 'y'.repeat(50000) }], { budgetChars: 10000 });
    t('单条超长也被压到预算内', one.chars <= 10000, true);
    t('单条超长会标记截断', one.truncated >= 1, true);

    const small = [{ role: 'user', content: 'hi' }];
    t('未超预算不裁剪', compactMessages(small, { budgetChars: 1000 }).compacted, false);

    // 相关性优先：中间段里「与提问相关」的那条要被保留
    const msgs2 = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'A'.repeat(3000) + ' 无关内容甲' },
        { role: 'assistant', content: 'B'.repeat(3000) },
        { role: 'user', content: '部署脚本在 ops/deploy.ps1，注意端口' },
        { role: 'assistant', content: 'C'.repeat(3000) },
        { role: 'user', content: '部署脚本在哪' },
    ];
    const c2 = compactMessages(msgs2, { budgetChars: 9000, headKeep: 1, tailKeep: 1, relevanceFloor: 0.05 });
    t('相关中间段被保留', c2.messages.some((m) => String(m.content).includes('ops/deploy.ps1')), true);

    // 命名
    t('快照名含会话与长度', snapshotName('abc', 'hash1234567890', 5000), 'kvp-abc-hash12345678-5000.bin');
    t('会话名非法字符被清理', snapshotName('a/b c', 'h', 1), 'kvp-abc-h-1.bin');

    const bad = R.filter((r) => !r.ok);
    for (const r of R) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  got=${JSON.stringify(r.got)} want=${JSON.stringify(r.want)}`);
    console.log(`\n${R.length - bad.length}/${R.length} passed`);
    return bad.length === 0;
}

if (process.argv[1] && /lib\.mjs$/.test(process.argv[1]) && process.argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
}
