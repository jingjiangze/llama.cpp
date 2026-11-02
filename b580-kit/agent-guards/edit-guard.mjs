// edit-guard：单文件精确替换的「执行前校验」+「执行后验收」
//
// 设计目标（照抄 v1.0.0 的行为约定，去掉它对本机 dsh 运行时的依赖）：
//   1. 只在「最新指令明确要求单文件精确替换」且「会话已有该文件的读取证据」时才介入
//   2. 执行前校验 目标存在 / old 唯一命中 / old≠new；不匹配就 deny，并把 目标+old+new+命中数 回传
//   3. 绝不改写调用方参数、绝不静默替换路径
//   4. 多文件任务（≥2 个明确路径）自动让路
//   5. 执行后用真实文件内容做一次验收（new 在、old 不在）
//
// CLI: node edit-guard.mjs --stdin-json        （从 stdin 读 payload，输出 JSON）
//      node edit-guard.mjs --selftest         （内置断言，秒级）
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// 「明确要求单文件精确替换」的意图词。命中任一即认为有意图。
const EXACT_INTENT = [
    '只改', '只修改', '只替换', '仅改', '仅修改', '仅替换',
    '唯一', '唯一一处', '单独改',
    'only change', 'only edit', 'only replace', 'exactly once',
];

// 从指令里抽「明确的文件路径」（用于多文件让路判定）
const PATH_RE = /[A-Za-z0-9_\-./\\]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|c|cc|h|hpp|cpp|java|kt|kts|swift|cs|php|rb|pl|lua|scala|txt|log|ini|cfg|conf|xml|md|markdown|json|jsonl|ya?ml|toml|sh|bash|zsh|ps1|cmd|bat|html|htm|css|scss|less|sql|vue|svelte)\b/gi;

export function explicitPaths(instruction) {
    const set = new Set();
    for (const m of String(instruction || '').matchAll(PATH_RE)) {
        // 去掉纯扩展名片段与前后的标点
        const p = m[0].replace(/^[.\-/\\]+/, '').replace(/[.,;:]+$/, '');
        if (p.includes('.') && p.length > 2) set.add(p);
    }
    return [...set];
}

export function hasExactIntent(instruction) {
    const s = String(instruction || '').toLowerCase();
    return EXACT_INTENT.some((k) => s.includes(k.toLowerCase()));
}

function countOccurrences(haystack, needle) {
    if (!needle) return 0;
    let n = 0, i = 0;
    while (true) {
        const j = haystack.indexOf(needle, i);
        if (j < 0) break;
        n++;
        i = j + needle.length;
    }
    return n;
}

function deny(code, message, details = {}) {
    return { decision: 'deny', code, message, details };
}
function allow(code = 'ok', details = {}) {
    return { decision: 'allow', code, details };
}
function skip(code, message, details = {}) {
    return { decision: 'skip', code, message, details };
}

// 执行前校验
export function checkPre(payload, { readFile = (p) => fs.readFileSync(p, 'utf8'), exists = (p) => fs.existsSync(p) } = {}) {
    const { instruction = '', target, old: oldText = '', new: newText = '', session_reads = [] } = payload || {};

    if (!target) return deny('no_target', '未提供目标路径', {});

    const paths = explicitPaths(instruction);
    if (paths.length >= 2) {
        return skip('multi_file_bypass', '指令里有 ≥2 个明确文件路径，多文件任务由上层自行处理', { paths });
    }
    if (!hasExactIntent(instruction)) {
        return skip('no_exact_intent', '指令没有「只改/唯一/exactly」类精确替换意图，不介入', {});
    }
    if (!session_reads.map((p) => path.normalize(p)).includes(path.normalize(target))) {
        return deny('no_read_evidence', '会话里没有该文件的读取证据，拒绝盲改', { target, session_reads });
    }
    if (!exists(target)) {
        return deny('target_missing', '目标文件不存在（不会自动新建或换路径）', { target });
    }
    if (!oldText) return deny('empty_old', 'old 为空，精确替换需要非空 old', { target });
    if (oldText === newText) return deny('no_change', 'old 与 new 完全相同，属于空操作', { target });

    const content = readFile(target);
    const occ = countOccurrences(content, oldText);
    if (occ === 0) {
        return deny('old_not_found', 'old 在文件里一处都找不到（可能已被改过或转义不符）', {
            target,
            old_head: oldText.slice(0, 120),
        });
    }
    if (occ > 1) {
        return deny('old_ambiguous', `old 在文件里命中 ${occ} 处，不唯一，拒绝替换`, {
            target,
            occurrences: occ,
            hint: '把 old 扩展到能唯一定位的上下文，或改用行范围',
        });
    }
    return allow('pre_ok', { target, occurrences: 1, target_bytes: content.length });
}

// 执行后验收：用真实文件内容确认结果
export function checkPost(payload, { readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
    const { target, old: oldText = '', new: newText = '' } = payload || {};
    if (!target) return deny('no_target', '未提供目标路径', {});
    let content;
    try {
        content = readFile(target);
    } catch (e) {
        return deny('target_unreadable', '执行后读不到目标文件', { target, err: String(e && e.message || e) });
    }
    const nNew = countOccurrences(content, newText);
    const nOld = oldText ? countOccurrences(content, oldText) : 0;
    if (nNew === 0) {
        return deny('post_new_missing', '执行后文件里找不到 new，替换没有真正落盘', { target });
    }
    if (nOld > 0) {
        return deny('post_old_remains', `执行后 old 仍存在 ${nOld} 处`, { target, remaining_old: nOld });
    }
    return allow('post_ok', { target, new_hits: nNew });
}

// ---- 自测 ----
function selftest() {
    const tmp = path.join(process.env.TEMP || '.', `edit-guard-selftest-${process.pid}`);
    fs.mkdirSync(tmp, { recursive: true });
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'alpha\nbeta\ngamma\n');
    const dup = path.join(tmp, 'b.txt');
    fs.writeFileSync(dup, 'x\nx\n');

    const R = [];
    const t = (name, got, want, extra = '') => {
        const ok = got === want;
        R.push({ name, ok, got, want, extra });
    };

    const base = { instruction: '只改 a.txt 这一处', target: f, session_reads: [f] };

    t('唯一命中→allow', checkPre({ ...base, old: 'beta', new: 'BETA' }).code, 'pre_ok');
    t('old 不存在→deny', checkPre({ ...base, old: 'delta', new: 'D' }).code, 'old_not_found');
    t('old 不唯一→deny', checkPre({ ...base, target: dup, session_reads: [dup], old: 'x', new: 'y' }).code, 'old_ambiguous');
    t('无读取证据→deny', checkPre({ ...base, session_reads: [], old: 'beta', new: 'B' }).code, 'no_read_evidence');
    t('old==new→deny', checkPre({ ...base, old: 'beta', new: 'beta' }).code, 'no_change');
    t('目标不存在→deny', checkPre({ ...base, target: path.join(tmp, 'nope.txt'), session_reads: [path.join(tmp, 'nope.txt')], old: 'a', new: 'b' }).code, 'target_missing');
    t('多文件让路→skip', checkPre({ ...base, instruction: '只改 a.txt 和 b.txt', old: 'beta', new: 'B' }).code, 'multi_file_bypass');
    t('无精确意图→skip', checkPre({ ...base, instruction: '看看 a.txt 能不能优化', old: 'beta', new: 'B' }).code, 'no_exact_intent');
    t('英文意图可识别', hasExactIntent('only change this line'), true);
    t('路径抽取', JSON.stringify(explicitPaths('把 a.txt 和 b.txt 都改').sort()), JSON.stringify([path.join('a.txt'), path.join('b.txt')].sort()) === JSON.stringify(['a.txt', 'b.txt']) ? JSON.stringify(['a.txt', 'b.txt']) : JSON.stringify(explicitPaths('把 a.txt 和 b.txt 都改').sort()));

    // 执行后验收
    fs.writeFileSync(f, 'alpha\nBETA\ngamma\n');
    t('post: new 在 old 走→allow', checkPost({ target: f, old: 'beta', new: 'BETA' }).code, 'post_ok');
    fs.writeFileSync(f, 'alpha\nbeta\ngamma\n');
    t('post: new 不在→deny', checkPost({ target: f, old: 'beta', new: 'BETA' }).code, 'post_new_missing');

    fs.rmSync(tmp, { recursive: true, force: true });

    const bad = R.filter((r) => !r.ok);
    for (const r of R) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  got=${JSON.stringify(r.got)} want=${JSON.stringify(r.want)}`);
    console.log(`\n${R.length - bad.length}/${R.length} passed`);
    return bad.length === 0;
}

// ---- CLI ----
function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) {
        process.exit(selftest() ? 0 : 1);
    }
    if (argv.includes('--stdin-json')) {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => { raw += d; });
        process.stdin.on('end', () => {
            let payload;
            try {
                payload = JSON.parse(raw);
            } catch (e) {
                process.stdout.write(JSON.stringify(deny('bad_json', 'payload 不是合法 JSON', { err: String(e.message) })) + '\n');
                process.exit(2);
            }
            const res = payload.phase === 'post' ? checkPost(payload) : checkPre(payload);
            process.stdout.write(JSON.stringify(res) + '\n');
            process.exit(res.decision === 'deny' ? 1 : 0);
        });
        return;
    }
    console.log(`edit-guard
用法:
  node edit-guard.mjs --stdin-json     # 从 stdin 读 payload，输出 JSON；deny 时退出码 1
  node edit-guard.mjs --selftest       # 内置断言

payload（执行前）:
  {"phase":"pre","instruction":"只改 a.mjs 里那一行","target":"a.mjs",
   "old":"原字符串","new":"新字符串","session_reads":["a.mjs"]}
payload（执行后）:
  {"phase":"post","target":"a.mjs","old":"原字符串","new":"新字符串"}`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'edit-guard.mjs') main();
