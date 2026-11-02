// structured-feedback：把工具失败回传成**结构化**反馈（而不是自由文本）
//
// 依据（v1.0.0 实测）：结构化反馈后一次恢复 10/10，自由文本（generic）0/10。
// 关键是四件事必须齐：**在哪失败 / 失败码 / 是否可重试 / 下一步该怎么做**。
// 只给「出错了」等于没给信息，模型只能瞎猜或原地重试。
//
// CLI: node structured-feedback.mjs --stdin-json   {tool,target,error|raw}
//      node structured-feedback.mjs --selftest
import process from 'node:process';
import path from 'node:path';

// 失败码 → {retryable, hint, next_action}
// next_action 必须是**可执行**的一步，不能是「请重试」这种空话。
const TABLE = {
    ENOENT: { retryable: false, hint: '路径不存在', next: '先列出父目录确认实际文件名，再用确认后的路径重做' },
    EACCES: { retryable: false, hint: '没有写/读权限', next: '改用可写目录，或明确告知该路径不可写并停下' },
    EPERM: { retryable: false, hint: '操作被系统拒绝', next: '不要绕过权限；报告被拒绝的路径与操作' },
    EISDIR: { retryable: false, hint: '目标是目录不是文件', next: '确认要操作的是该目录下的哪个文件' },
    ENOSPC: { retryable: false, hint: '磁盘空间不足', next: '先清理或换目标盘，不要重试同样的写入' },
    EBUSY: { retryable: true, hint: '文件被占用', next: '等占用释放后重试一次；仍失败则换输出路径' },
    ETIMEDOUT: { retryable: true, hint: '超时', next: '缩小请求规模后重试一次，不要原样重发' },
    ECONNRESET: { retryable: true, hint: '连接被重置', next: '重试一次；连续两次失败就改走本地或另一条通道' },
    EDIT_OLD_NOT_FOUND: { retryable: true, hint: 'old 在文件里找不到', next: '重新读取该文件，用文件里的原文作为 old；不要凭记忆拼写' },
    EDIT_OLD_AMBIGUOUS: { retryable: true, hint: 'old 命中多处，不唯一', next: '把 old 扩展到能唯一定位的上下文，或改用行范围替换' },
    EDIT_NO_READ_EVIDENCE: { retryable: true, hint: '没有先读该文件就要改', next: '先读取目标文件，再提交替换' },
    EDIT_NO_CHANGE: { retryable: false, hint: 'old 与 new 相同', next: '这是空操作，确认是否本来就不需要改' },
    JSON_PARSE: { retryable: true, hint: '返回体不是合法 JSON', next: '检查是否被截断（max_tokens 不足）或混入非 JSON 前缀' },
    TRUNCATED: { retryable: true, hint: '输出被截断', next: '提高 max_tokens 或分段落输出；reasoning 预算也会挤占额度' },
    EXIT_CODE: { retryable: true, hint: '子进程非零退出', next: '先读 stderr 的最后 20 行定位根因，再决定改代码还是改命令' },
    UNKNOWN: { retryable: true, hint: '未分类错误', next: '先把完整报错（含堆栈与退出码）取全，再判断' },
};

// 从原始报错文本里猜分类
export function classify(raw) {
    const s = String(raw || '');
    // 编辑守卫自己的中文码词先判，避免落到 UNKNOWN
    if (/不唯一|命中\s*\d+\s*处|多处匹配/.test(s)) return 'EDIT_OLD_AMBIGUOUS';
    if (/一处都找不到|找不到 old|old.*找不到/.test(s)) return 'EDIT_OLD_NOT_FOUND';
    if (/读取证据|没有先读|盲改/.test(s)) return 'EDIT_NO_READ_EVIDENCE';
    if (/空操作|完全相同/.test(s)) return 'EDIT_NO_CHANGE';
    if (/ENOENT|no such file|not found|找不到|cannot find/i.test(s)) return 'ENOENT';
    if (/EACCES|permission denied|拒绝访问/i.test(s)) return 'EACCES';
    if (/EPERM|operation not permitted/i.test(s)) return 'EPERM';
    if (/EISDIR|is a directory/i.test(s)) return 'EISDIR';
    if (/ENOSPC|no space left/i.test(s)) return 'ENOSPC';
    if (/EBUSY|being used by another process|另一个程序正在使用/i.test(s)) return 'EBUSY';
    if (/ETIMEDOUT|timed out|超时/i.test(s)) return 'ETIMEDOUT';
    if (/ECONNRESET|connection reset/i.test(s)) return 'ECONNRESET';
    if (/JSON|Unexpected token|parse error|unexpected end of JSON/i.test(s)) return 'JSON_PARSE';
    if (/truncat|max_tokens|context.*exceed/i.test(s)) return 'TRUNCATED';
    if (/exit code|exit status|returned non-zero|\brc=\d+/.test(s)) return 'EXIT_CODE';
    return 'UNKNOWN';
}

export function feedback(input) {
    const tool = input?.tool || 'unknown';
    const target = input?.target || null;
    const code = input?.code && TABLE[input.code] ? input.code : classify(input?.error ?? input?.raw ?? input?.message ?? '');

    const base = TABLE[code] || TABLE.UNKNOWN;
    const retryable = typeof input?.retryable === 'boolean' ? input.retryable : base.retryable;
    const hint = input?.hint || base.hint;
    const next = input?.next || base.next;
    const detail = String(input?.error ?? input?.raw ?? input?.message ?? '').trim().slice(0, 400);

    return {
        ok: false,
        tool,
        target,
        code,
        retryable,
        hint,
        next_action: next,
        detail,
        // 给人类看的一行
        message: `${tool}${target ? '(' + target + ')' : ''} 失败：${code} — ${hint}`,
    };
}

// 渲染成回灌给模型的块。刻意保持确定性格式，便于模型解析、也便于做 diff。
export function render(fb) {
    const lines = [
        '<<TOOL_ERROR>>',
        `tool: ${fb.tool}`,
        `target: ${fb.target ?? '-'}`,
        `code: ${fb.code}`,
        `retryable: ${fb.retryable ? 'yes' : 'no'}`,
        `hint: ${fb.hint}`,
        `next_action: ${fb.next_action}`,
    ];
    if (fb.detail) {
        lines.push('detail: |');
        for (const ln of fb.detail.split(/\r?\n/).slice(0, 12)) lines.push('  ' + ln);
    }
    lines.push('<</TOOL_ERROR>>');
    return lines.join('\n');
}

function selftest() {
    const R = [];
    const t = (name, got, want) => R.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want });

    t('ENOENT 分类', classify('Error: ENOENT: no such file or directory'), 'ENOENT');
    t('中文不唯一→编辑码', classify('old 在文件里命中 2 处，不唯一'), 'EDIT_OLD_AMBIGUOUS');
    t('中文找不到→编辑码', classify('old 在文件里一处都找不到'), 'EDIT_OLD_NOT_FOUND');
    t('中文空操作→编辑码', classify('old 与 new 完全相同，属于空操作'), 'EDIT_NO_CHANGE');
    t('权限分类', classify("EACCES: permission denied, open 'x'"), 'EACCES');
    t('JSON 分类', classify('Unexpected end of JSON input'), 'JSON_PARSE');
    t('退出码分类', classify('command returned non-zero exit code 2'), 'EXIT_CODE');
    t('超时分类', classify('request timed out after 30s'), 'ETIMEDOUT');

    const a = feedback({ tool: 'edit_file', target: 'a.mjs', error: 'ENOENT: no such file' });
    t('ENOENT 不可重试', a.retryable, false);
    t('ENOENT 有下一步', typeof a.next_action === 'string' && a.next_action.length > 5, true);

    const b = feedback({ tool: 'edit_file', target: 'a.mjs', code: 'EDIT_OLD_AMBIGUOUS' });
    t('显式码优先', b.code, 'EDIT_OLD_AMBIGUOUS');
    t('唯一性错误可重试', b.retryable, true);

    const c = feedback({ tool: 'x', error: 'something weird happened' });
    t('未分类兜底', c.code, 'UNKNOWN');
    t('兜底也有 next_action', c.next_action, TABLE.UNKNOWN.next);

    const txt = render(a);
    t('渲染含标记', txt.startsWith('<<TOOL_ERROR>>') && txt.endsWith('<</TOOL_ERROR>>'), true);
    t('渲染含 code', txt.includes('code: ENOENT'), true);
    t('渲染含 next_action', txt.includes('next_action: '), true);

    // 确定性：同一输入两次渲染一致
    t('渲染确定性', render(a) === render(feedback({ tool: 'edit_file', target: 'a.mjs', error: 'ENOENT: no such file' })), true);

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
                process.stdout.write(render(feedback({ tool: 'structured-feedback', error: String(e.message), code: 'JSON_PARSE' })) + '\n');
                process.exit(2);
            }
            const fb = feedback(payload);
            process.stdout.write((argv.includes('--text') ? render(fb) : JSON.stringify(fb, null, 2)) + '\n');
            process.exit(0);
        });
        return;
    }
    console.log(`structured-feedback
用法:
  node structured-feedback.mjs --stdin-json          # 输出 JSON
  node structured-feedback.mjs --stdin-json --text   # 输出回灌给模型的 <<TOOL_ERROR>> 块
  node structured-feedback.mjs --selftest`);
}

if (process.argv[1] && path.basename(process.argv[1]) === 'structured-feedback.mjs') main();
