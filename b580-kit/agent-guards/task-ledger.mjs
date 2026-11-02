// task-ledger：多动作任务的「剩余动作账本」
//
// 行为约定（照 v1.0.0 的 task-ledger，去掉 dsh 钩子依赖）：
//   1. 从「最新用户指令」解析 move / edit / write 三类动作及目标路径
//   2. 用成功的工具结果标记完成项
//   3. agent 想停时，若仍有未完成动作，产出一条**结构化**「剩余动作」提醒
//   4. 不执行工具、不改写参数、不自动补写文件
//
// CLI: node task-ledger.mjs --stdin-json   {instruction, results:[{tool,path,to,ok}]}
//      node task-ledger.mjs --selftest
import path from 'node:path';
import process from 'node:process';

const FILE_RE = /[A-Za-z0-9_\-./\\]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|go|rs|c|cc|h|hpp|cpp|java|kt|kts|swift|cs|php|rb|pl|lua|scala|txt|log|ini|cfg|conf|xml|md|markdown|json|jsonl|ya?ml|toml|sh|bash|zsh|ps1|cmd|bat|html|htm|css|scss|less|sql|vue|svelte)\b/gi;

function filesIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(FILE_RE)) {
        const p = m[0].replace(/^[.\-/\\]+/, '').replace(/[.,;:]+$/, '');
        if (p.length > 2 && !out.includes(p)) out.push(p);
    }
    return out;
}

// 把指令切成子句，逐句判定动作类型
// 中文逗号/顿号、句号、分号、换行都要切；连接词（然后/接着/最后/并且/同时）也当分隔
function clauses(instruction) {
    return String(instruction || '')
        .split(/[。；;，,、\n]+/)
        .flatMap((s) => s.split(/(?:然后再|然后|接着|最后|并且|同时|and then|then)\s*/i))
        .map((s) => s.trim())
        .filter(Boolean);
}

export function parseActions(instruction) {
    const actions = [];
    for (const c of clauses(instruction)) {
        const low = c.toLowerCase();
        const fs_ = filesIn(c);

        // move A to B / 把 A 移动到 B
        if (/(^|\s)move\b|移动|挪到|移到|搬到/.test(low + c) && fs_.length >= 1) {
            const to = /(?:to|到|至)\s*([A-Za-z0-9_\-./\\]+\.[a-z0-9]+)/i.exec(c);
            actions.push({
                kind: 'move',
                path: fs_[0],
                to: to ? to[1].replace(/^[.\-/\\]+/, '') : (fs_[1] || null),
                raw: c,
            });
            continue;
        }
        // write / create / 新建 / 写
        if (/(^|\s)(write|create|add file)\b|新建|新增|创建|写入|生成/.test(low + c) && fs_.length >= 1) {
            actions.push({ kind: 'write', path: fs_[0], raw: c });
            continue;
        }
        // edit / modify / change / 改 / 修改 / 替换
        if (/(^|\s)(edit|modify|change|update|replace)\b|改|修改|替换|调整/.test(low + c) && fs_.length >= 1) {
            actions.push({ kind: 'edit', path: fs_[0], raw: c });
            continue;
        }
    }
    // 去重（同一 kind+path 只留一条）
    const seen = new Set();
    return actions.filter((a) => {
        const k = `${a.kind}|${path.normalize(a.path)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

const norm = (p) => path.normalize(String(p || '').replace(/^[.\-/\\]+/, ''));

export function reconcile(actions, results) {
    const done = new Map();
    for (const r of results || []) {
        if (!r || r.ok === false) continue;
        const tool = String(r.tool || '').toLowerCase();
        if (!['edit', 'write', 'move', 'apply_patch', 'str_replace', 'create', 'rename'].some((k) => tool.includes(k))) continue;
        done.set(norm(r.path), tool);
        if (r.to) done.set(norm(r.to), tool);
    }
    return actions.map((a) => ({ ...a, done: done.has(norm(a.path)) }));
}

export function ledger(payload) {
    const actions = parseActions(payload?.instruction || '');
    const withState = reconcile(actions, payload?.results || []);
    const remaining = withState.filter((a) => !a.done);

    let reminder = null;
    if (remaining.length > 0) {
        const lines = remaining.map((a, i) =>
            `${i + 1}. ${a.kind} ${a.path}${a.to ? ' -> ' + a.to : ''}`);
        reminder = {
            code: 'remaining_actions',
            count: remaining.length,
            actions: remaining.map((a) => ({ kind: a.kind, path: a.path, to: a.to || null })),
            message: `指令里还有 ${remaining.length} 个动作没完成，不要现在停下：\n` + lines.join('\n'),
        };
    }
    return {
        total: withState.length,
        done: withState.filter((a) => a.done).length,
        actions: withState.map((a) => ({ kind: a.kind, path: a.path, to: a.to || null, done: a.done })),
        remaining: remaining.map((a) => ({ kind: a.kind, path: a.path, to: a.to || null })),
        reminder,
    };
}

function selftest() {
    const R = [];
    const t = (name, got, want) => R.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

    const instr = '先把 a.mjs 移动成 b.mjs，然后修改 c.mjs 里的常量，最后新建 d.md 写说明';
    const acts = parseActions(instr);
    t('解析出 3 个动作', acts.length, 3);
    t('动作类型顺序', acts.map((a) => a.kind), ['move', 'edit', 'write']);
    t('move 的目标', acts[0].path + '->' + acts[0].to, 'a.mjs->b.mjs');

    const led1 = ledger({ instruction: instr, results: [] });
    t('全未完成→3 条提醒', led1.remaining.length, 3);
    t('提醒码', led1.reminder && led1.reminder.code, 'remaining_actions');

    const led2 = ledger({
        instruction: instr,
        results: [{ tool: 'move_file', path: 'a.mjs', to: 'b.mjs', ok: true }, { tool: 'edit_file', path: 'c.mjs', ok: true }],
    });
    t('完成 2 个→剩 1', led2.remaining.length, 1);
    t('剩下的是 write', led2.remaining[0].kind, 'write');

    const led3 = ledger({
        instruction: instr,
        results: [
            { tool: 'move_file', path: 'a.mjs', to: 'b.mjs', ok: true },
            { tool: 'edit_file', path: 'c.mjs', ok: true },
            { tool: 'write_file', path: 'd.md', ok: true },
        ],
    });
    t('全部完成→无提醒', led3.reminder, null);

    t('失败的工具不算完成', ledger({
        instruction: '修改 c.mjs',
        results: [{ tool: 'edit_file', path: 'c.mjs', ok: false }],
    }).remaining.length, 1);

    t('单动作也记账', ledger({ instruction: '只改 a.mjs 里那一行', results: [] }).total, 1);

    const bad = R.filter((r) => !r.ok);
    for (const r of R) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  got=${JSON.stringify(r.got)} want=${JSON.stringify(r.want)}`);
    console.log(`\n${R.length - bad.length}/${R.length} passed`);
    return bad.length === 0;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
    if (argv.includes('--stdin-json')) {
        let raw = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (d) => { raw += d; });
        process.stdin.on('end', () => {
            let payload;
            try {
                payload = JSON.parse(raw);
            } catch (e) {
                process.stdout.write(JSON.stringify({ error: 'bad_json', err: String(e.message) }) + '\n');
                process.exit(2);
            }
            process.stdout.write(JSON.stringify(ledger(payload)) + '\n');
            process.exit(0);
        });
        return;
    }
    console.log(`task-ledger
用法:
  node task-ledger.mjs --stdin-json   # {"instruction":"...","results":[{"tool":"edit_file","path":"a.mjs","ok":true}]}
  node task-ledger.mjs --selftest`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'task-ledger.mjs') main();
