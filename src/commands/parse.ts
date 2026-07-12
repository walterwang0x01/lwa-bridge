/**
 * 斜杠命令解析
 *
 * 支持的命令：
 *   /new, /reset           新建会话 id（CLI）/ 重置底层 session
 *   /clear                 清空摘要与底层 session，保留当前 id
 *   /cd <path>             切换工作目录
 *   /pwd                   查看当前目录
 *   /ws list               列出所有命名工作区
 *   /ws save <name>        把当前 cwd 存为命名工作区
 *   /ws use <name>         切换到命名工作区
 *   /ws remove <name>      删除命名工作区
 *   /status                查看会话状态
 *   /sessions              列出 CLI 会话
 *   /resume [id]           切换/恢复 CLI 会话
 *   /rename <title>        命名当前 CLI 会话
 *   /parallel <wt> <prompt> 在 worktree 后台并行跑 agent
 *   /jobs [id]             查看并行 job
 *   /compact [focus]       压缩当前会话上下文
 *   /plan [text]           进入 plan 阶段（或直接规划）
 *   /review [text]         进入 review 阶段（或直接审查）
 *   /stop                  停止当前任务
 *   /timeout <N|off|default>  调整当前 chat 的 idle watchdog（分钟）
 *   /reconnect             重连 WebSocket
 *   /doctor [描述]          CLI 无描述=本地体检；有描述=日志交给 Kiro 诊断
 *   /model                 列出可用模型 + 当前选中
 *   /model <name>          切换模型并写入 config.json（auto/default 表示清除覆盖）
 *   /help                  帮助
 *
 * kiro-cli 其他内置 TUI 命令（/agent /tools /login /logout）
 *   在非交互模式下 kiro-cli 不识别，会被 LLM 当成普通问题"假装"回答。
 *   桥接器拦下来给一个明确的提示，避免误导用户。
 *   注意：/compact /sessions /clear 已升级为 LWA 自有命令。
 *
 * 不识别的 /xxx 命令会被原样转发给 Kiro（让用户自己定义）。
 */
export type ParsedCommand =
  | { kind: 'new' }
  | { kind: 'clear' }
  | { kind: 'cd'; path: string }
  | { kind: 'pwd' }
  | { kind: 'ws-list' }
  | { kind: 'ws-save'; name: string }
  | { kind: 'ws-use'; name: string }
  | { kind: 'ws-remove'; name: string }
  | { kind: 'status' }
  | { kind: 'sessions' }
  | { kind: 'resume'; id?: string }
  | { kind: 'rename'; title: string }
  | { kind: 'compact'; focus?: string }
  | { kind: 'phase-plan'; prompt?: string }
  | { kind: 'phase-review'; prompt?: string }
  | { kind: 'phase-apply' }
  | { kind: 'explore'; query: string }
  | { kind: 'subtest'; query?: string }
  | { kind: 'parallel'; worktree: string; prompt: string }
  | { kind: 'jobs'; id?: string }
  | { kind: 'worktree'; mode: 'list' }
  | { kind: 'worktree'; mode: 'add'; name: string }
  | { kind: 'worktree'; mode: 'use'; name: string }
  | { kind: 'worktree'; mode: 'rm'; name: string }
  | { kind: 'worktree'; mode: 'help' }
  | { kind: 'stop' }
  | { kind: 'timeout'; mode: 'set'; minutes: number }
  | { kind: 'timeout'; mode: 'off' }
  | { kind: 'timeout'; mode: 'default' }
  | { kind: 'timeout'; mode: 'show' }
  | { kind: 'reconnect' }
  | { kind: 'doctor'; description: string }
  | { kind: 'selftest' }
  | { kind: 'config'; mode: 'show' }
  | { kind: 'ps' }
  | { kind: 'exit'; target: string }
  | { kind: 'memory'; mode: 'list'; scope: 'global' | 'project' }
  | { kind: 'memory'; mode: 'view'; scope: 'global' | 'project'; name: string }
  | { kind: 'memory'; mode: 'edit'; scope: 'global' | 'project'; name: string }
  | { kind: 'memory'; mode: 'new'; scope: 'global' | 'project'; name: string }
  | { kind: 'memory'; mode: 'rm'; scope: 'global' | 'project'; name: string }
  | { kind: 'cron'; mode: 'list' }
  | { kind: 'cron'; mode: 'add'; expression: string; prompt: string }
  | { kind: 'cron'; mode: 'rm'; id: string }
  | { kind: 'cron'; mode: 'pause'; id: string }
  | { kind: 'cron'; mode: 'resume'; id: string }
  | { kind: 'cron'; mode: 'run'; id: string }
  | { kind: 'cron'; mode: 'next'; id: string }
  | { kind: 'cron'; mode: 'translate'; raw: string }
  | { kind: 'schedule'; mode: 'new' }
  | { kind: 'conduit'; mode: 'run' }
  | { kind: 'conduit'; mode: 'run-merge' }
  | { kind: 'conduit'; mode: 'plan'; spec: string }
  | { kind: 'conduit'; mode: 'help' }
  | { kind: 'skill'; mode: 'list' }
  | { kind: 'skill'; mode: 'source-add'; name: string; url: string }
  | { kind: 'skill'; mode: 'source-list' }
  | { kind: 'skill'; mode: 'source-remove'; name: string }
  | { kind: 'skill'; mode: 'sync'; name: string }
  | { kind: 'skill'; mode: 'install'; name: string; assetId: string }
  | { kind: 'agent'; mode: 'show' }
  | { kind: 'agent'; mode: 'set'; name: string }
  | { kind: 'agent'; mode: 'create'; name: string }
  | { kind: 'agent'; mode: 'reset' }
  | { kind: 'agent'; mode: 'sync'; source: string }
  | { kind: 'agent'; mode: 'install'; source: string; assetId: string }
  | { kind: 'agent'; mode: 'install-defaults' }
  | { kind: 'model'; mode: 'show' }
  | { kind: 'model'; mode: 'set'; name: string }
  | { kind: 'model'; mode: 'reset' }
  | { kind: 'runtime'; mode: 'show' }
  | { kind: 'runtime'; mode: 'check' }
  | { kind: 'runtime'; mode: 'set'; name: string }
  | { kind: 'help' }
  | { kind: 'kiro-internal'; name: string }
  | { kind: 'unknown'; raw: string };

/**
 * kiro-cli 内置命令名（不含开头的 /）。
 * 这些在非交互模式（bridge 用 ACP 程序化驱动）下不会被 kiro-cli 识别，需要桥接器主动拦截。
 * 注意：/model 已升级成桥接器自己的命令，不在这里。
 */
const KIRO_INTERNAL_COMMANDS = new Set(['tools', 'login', 'logout', 'usage', 'cost', 'profile']);

/**
 * 命令名容错表：常见 typo / 别名 / 缩写 → 标准命令名。
 * 用户在 IM 里打字快、容易漏字母，这里宽容处理一下，体感会好很多。
 */
const COMMAND_ALIASES: Record<string, string> = {
  // /model 系列
  m: 'model',
  mod: 'model',
  mode: 'model',
  modle: 'model',
  models: 'model',
  // /runtime 系列
  engine: 'runtime',
  cli: 'runtime',
  // /help 系列
  h: 'help',
  '?': 'help',
  // /status 系列
  s: 'status',
  stat: 'status',
  // /sessions
  sess: 'sessions',
  // /compact
  summarize: 'compact',
  compress: 'compact',
  // /new 系列
  reset: 'new',
  // /clear 独立：清空上下文，不新建 id
  // /stop 系列
  abort: 'stop',
  cancel: 'stop',
  // /pwd 系列
  cwd: 'pwd',
  // /reconnect
  reconect: 'reconnect',
  rc: 'reconnect',
  // /timeout
  to: 'timeout',
  // /jobs
  job: 'jobs',
};

function normalizeCommandHead(head: string): string {
  const lower = head.toLowerCase();
  return COMMAND_ALIASES[lower] ?? lower;
}

/**
 * 尝试解析为命令。返回 null 表示不是命令（普通消息丢给 Kiro）。
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const rest = trimmed.slice(1);
  const [headRaw, ...tailParts] = rest.split(/\s+/);
  const tail = tailParts.join(' ').trim();

  // 命令名容错：常见 typo / 别名 → 标准名
  const head = normalizeCommandHead(headRaw ?? '');

  switch (head) {
    case 'new':
    case 'reset':
      return { kind: 'new' };
    case 'clear':
      return { kind: 'clear' };
    case 'cd':
      if (!tail) return { kind: 'unknown', raw: trimmed };
      return { kind: 'cd', path: tail };
    case 'pwd':
      return { kind: 'pwd' };
    case 'status':
      return { kind: 'status' };
    case 'sessions':
    case 'session':
      return { kind: 'sessions' };
    case 'resume':
    case 'continue':
      return { kind: 'resume', id: tail || undefined };
    case 'rename':
      if (!tail) return { kind: 'unknown', raw: trimmed };
      return { kind: 'rename', title: tail };
    case 'compact':
      return { kind: 'compact', focus: tail || undefined };
    case 'plan':
      // /plan 与 /conduit plan 区分：无 conduit 前缀时为阶段命令
      return { kind: 'phase-plan', prompt: tail || undefined };
    case 'review':
      return { kind: 'phase-review', prompt: tail || undefined };
    case 'apply':
      return { kind: 'phase-apply' };
    case 'explore':
      if (!tail) return { kind: 'unknown', raw: trimmed };
      return { kind: 'explore', query: tail };
    case 'test':
      return { kind: 'subtest', query: tail || undefined };
    case 'parallel':
    case 'par': {
      const sp = tail.indexOf(' ');
      if (sp <= 0) return { kind: 'unknown', raw: trimmed };
      const worktree = tail.slice(0, sp).trim();
      const prompt = tail.slice(sp + 1).trim();
      if (!worktree || !prompt) return { kind: 'unknown', raw: trimmed };
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(worktree)) return { kind: 'unknown', raw: trimmed };
      return { kind: 'parallel', worktree, prompt };
    }
    case 'jobs':
      return { kind: 'jobs', id: tail || undefined };
    case 'worktree':
    case 'wt': {
      if (!tail || tail === 'list' || tail === 'ls') return { kind: 'worktree', mode: 'list' };
      if (tail === 'help' || tail === '?') return { kind: 'worktree', mode: 'help' };
      const tokens = tail.split(/\s+/);
      const sub = (tokens[0] ?? '').toLowerCase();
      const name = tokens.slice(1).join(' ').trim();
      if ((sub === 'add' || sub === 'new' || sub === 'create') && name) {
        return { kind: 'worktree', mode: 'add', name };
      }
      if ((sub === 'use' || sub === 'cd') && name) {
        return { kind: 'worktree', mode: 'use', name };
      }
      if ((sub === 'rm' || sub === 'remove' || sub === 'delete') && name) {
        return { kind: 'worktree', mode: 'rm', name };
      }
      // /worktree <name> → add
      if (/^[a-zA-Z0-9._-]{1,64}$/.test(tail)) {
        return { kind: 'worktree', mode: 'add', name: tail };
      }
      return { kind: 'worktree', mode: 'help' };
    }
    case 'stop':
      return { kind: 'stop' };
    case 'reconnect':
      return { kind: 'reconnect' };
    case 'doctor':
      return { kind: 'doctor', description: tail };
    case 'selftest':
    case 'check':
      return { kind: 'selftest' };
    case 'config':
    case 'cfg':
    case 'settings':
      return { kind: 'config', mode: 'show' };
    case 'ps':
      return { kind: 'ps' };
    case 'exit':
    case 'kill': {
      if (!tail) return { kind: 'unknown', raw: trimmed };
      return { kind: 'exit', target: tail };
    }
    case 'steering':
    case 'memory':
    case 'mem': {
      // 解析 [--global] [子命令] [文件名]
      // 支持顺序：/steering [--global] [list|view|edit|new|rm] [name]
      const tokens = tail.split(/\s+/).filter(Boolean);
      let scope: 'global' | 'project' = 'project';
      const remaining: string[] = [];
      for (const t of tokens) {
        if (t === '--global' || t === '-g') {
          scope = 'global';
        } else {
          remaining.push(t);
        }
      }
      // 没有子命令 → list
      if (remaining.length === 0) {
        return { kind: 'memory', mode: 'list', scope };
      }
      const sub = remaining[0]?.toLowerCase() ?? '';
      const arg = remaining.slice(1).join(' ').trim();
      // /steering <name>（无子命令）→ 视作 view（看内容）
      if (
        sub !== 'list' &&
        sub !== 'view' &&
        sub !== 'cat' &&
        sub !== 'show' &&
        sub !== 'edit' &&
        sub !== 'new' &&
        sub !== 'create' &&
        sub !== 'rm' &&
        sub !== 'remove' &&
        sub !== 'delete'
      ) {
        return { kind: 'memory', mode: 'view', scope, name: remaining.join(' ') };
      }
      switch (sub) {
        case 'list':
          return { kind: 'memory', mode: 'list', scope };
        case 'view':
        case 'cat':
        case 'show':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'view', scope, name: arg };
        case 'edit':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'edit', scope, name: arg };
        case 'new':
        case 'create':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'new', scope, name: arg };
        case 'rm':
        case 'remove':
        case 'delete':
          if (!arg) return { kind: 'unknown', raw: trimmed };
          return { kind: 'memory', mode: 'rm', scope, name: arg };
        default:
          return { kind: 'unknown', raw: trimmed };
      }
    }
    case 'cron':
    case 'schedule': {
      // /cron                    → list
      // /cron list               → list
      // /cron add <expr> <prompt>
      // /cron rm <id>
      // /cron pause <id>
      // /cron resume <id>
      // /cron run <id>           手动立即跑一次
      // /cron next <id>          看下次触发
      // /cron translate <raw>    让 Kiro 翻译自然语言（卡片确认后才会调）
      //
      // /schedule 是 cron 的别名，但额外支持 /schedule new 弹可视化表单（小白入口）。
      // 当 head === 'schedule' 且 sub === 'new' 时走新表单分支。
      if (head === 'schedule') {
        const firstTok = (tail.split(/\s+/)[0] ?? '').toLowerCase();
        if (firstTok === 'new') {
          return { kind: 'schedule', mode: 'new' };
        }
      }
      if (!tail) return { kind: 'cron', mode: 'list' };
      const tokens = tail.split(/\s+/);
      const sub = (tokens[0] ?? '').toLowerCase();
      const restRaw = tail.slice((tokens[0] ?? '').length).trim();

      switch (sub) {
        case 'list':
        case 'ls':
          return { kind: 'cron', mode: 'list' };
        case 'add':
        case 'create':
        case 'new': {
          // /cron add <expr> <prompt>
          // expr 可能是单 token（cron / shorthand）或带空格的中文关键词。
          // 策略：如果 restRaw 第一个 token 是 cron 5 段（5 个空格分隔的 *|0-9|,|-|/|_）
          //       就把前 5 个 token 当 expr，其余当 prompt
          //       否则把第一个 token 当 expr（shorthand / 中文）
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          // 检查是否 5 段 cron（每段都是 cron 字符）
          const parts = restRaw.split(/\s+/);
          const cronCharRe = /^[\d*\-,/]+$/;
          if (parts.length >= 6 && parts.slice(0, 5).every((p) => cronCharRe.test(p))) {
            const expression = parts.slice(0, 5).join(' ');
            const prompt = parts.slice(5).join(' ').trim();
            if (!prompt) return { kind: 'unknown', raw: trimmed };
            return { kind: 'cron', mode: 'add', expression, prompt };
          }
          // 单 token expr
          const expression = parts[0] ?? '';
          const prompt = parts.slice(1).join(' ').trim();
          if (!expression || !prompt) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'add', expression, prompt };
        }
        case 'rm':
        case 'delete':
        case 'del':
        case 'remove': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'rm', id: restRaw };
        }
        case 'pause': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'pause', id: restRaw };
        }
        case 'resume': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'resume', id: restRaw };
        }
        case 'run':
        case 'fire': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'run', id: restRaw };
        }
        case 'next': {
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'next', id: restRaw };
        }
        case 'translate':
        case 'parse': {
          // 让 Kiro 翻译自然语言（dispatcher 拿到后弹卡片确认）
          if (!restRaw) return { kind: 'unknown', raw: trimmed };
          return { kind: 'cron', mode: 'translate', raw: restRaw };
        }
        default:
          return { kind: 'unknown', raw: trimmed };
      }
    }
    case 'skill': {
      // /skill                    → list
      // /skill source add <name> <url>
      // /skill source list
      // /skill source rm <name>
      // /skill sync <name>
      if (!tail) return { kind: 'skill', mode: 'list' };
      const tokens = tail.split(/\s+/);
      const sub = (tokens[0] ?? '').toLowerCase();
      if (sub === 'source') {
        const action = (tokens[1] ?? '').toLowerCase();
        if (action === 'list' || action === 'ls' || action === '') {
          return { kind: 'skill', mode: 'source-list' };
        }
        if (action === 'add' || action === 'new') {
          const name = tokens[2] ?? '';
          const url = tokens[3] ?? '';
          if (!name || !url) return { kind: 'unknown', raw: trimmed };
          return { kind: 'skill', mode: 'source-add', name, url };
        }
        if (action === 'rm' || action === 'remove' || action === 'delete') {
          const name = tokens[2] ?? '';
          if (!name) return { kind: 'unknown', raw: trimmed };
          return { kind: 'skill', mode: 'source-remove', name };
        }
        return { kind: 'unknown', raw: trimmed };
      }
      if (sub === 'sync') {
        const name = tokens[1] ?? '';
        if (!name) return { kind: 'unknown', raw: trimmed };
        return { kind: 'skill', mode: 'sync', name };
      }
      if (sub === 'install') {
        const name = tokens[1] ?? '';
        const assetId = tokens[2] ?? '';
        if (!name || !assetId) return { kind: 'unknown', raw: trimmed };
        return { kind: 'skill', mode: 'install', name, assetId };
      }
      if (sub === 'list' || sub === 'ls') {
        return { kind: 'skill', mode: 'list' };
      }
      return { kind: 'unknown', raw: trimmed };
    }
    case 'agent': {
      // /agent                    → show
      // /agent <name>             → set
      // /agent create <name>      → create
      // /agent reset              → reset
      // /agent sync <source>      → sync
      // /agent install-defaults   → install-defaults
      if (!tail) return { kind: 'agent', mode: 'show' };
      const lower = tail.toLowerCase();
      if (lower === 'reset' || lower === 'default' || lower === 'clear') {
        return { kind: 'agent', mode: 'reset' };
      }
      if (lower === 'install-defaults' || lower === 'defaults') {
        return { kind: 'agent', mode: 'install-defaults' };
      }
      const tokens = tail.split(/\s+/);
      const sub = (tokens[0] ?? '').toLowerCase();
      if (sub === 'create' || sub === 'new') {
        const name = tokens.slice(1).join(' ').trim();
        if (!name) return { kind: 'unknown', raw: trimmed };
        // agent 名只允许字母数字 + - + _ + .
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return { kind: 'unknown', raw: trimmed };
        return { kind: 'agent', mode: 'create', name };
      }
      if (sub === 'sync') {
        const source = tokens[1] ?? '';
        if (!source) return { kind: 'unknown', raw: trimmed };
        return { kind: 'agent', mode: 'sync', source };
      }
      if (sub === 'install') {
        const source = tokens[1] ?? '';
        const assetId = tokens[2] ?? '';
        if (!source || !assetId) return { kind: 'unknown', raw: trimmed };
        return { kind: 'agent', mode: 'install', source, assetId };
      }
      if (sub === 'show' || sub === 'list' || sub === 'ls') {
        return { kind: 'agent', mode: 'show' };
      }
      // 剩余情况：/agent <name> → set
      const name = tail.trim();
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) return { kind: 'unknown', raw: trimmed };
      return { kind: 'agent', mode: 'set', name };
    }
    case 'runtime':
    case 'rt': {
      if (!tail) return { kind: 'runtime', mode: 'show' };
      const lower = tail.toLowerCase();
      if (lower === 'check' || lower === 'doctor' || lower === 'health') {
        return { kind: 'runtime', mode: 'check' };
      }
      const name = tail.trim();
      if (!/^[a-zA-Z0-9._-]{1,32}$/.test(name)) return { kind: 'unknown', raw: trimmed };
      return { kind: 'runtime', mode: 'set', name };
    }
    case 'model': {
      if (!tail) return { kind: 'model', mode: 'show' };
      const lower = tail.toLowerCase();
      if (lower === 'auto' || lower === 'default' || lower === 'reset')
        return { kind: 'model', mode: 'reset' };
      // 模型名只允许字母数字 + - + .
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(tail)) {
        return { kind: 'unknown', raw: trimmed };
      }
      return { kind: 'model', mode: 'set', name: tail };
    }
    case 'timeout': {
      if (!tail) return { kind: 'timeout', mode: 'show' };
      const lower = tail.toLowerCase();
      if (lower === 'off' || lower === '0' || lower === 'disable')
        return { kind: 'timeout', mode: 'off' };
      if (lower === 'default' || lower === 'reset') return { kind: 'timeout', mode: 'default' };
      const n = Number(lower);
      if (Number.isFinite(n) && n > 0 && n <= 600) {
        return { kind: 'timeout', mode: 'set', minutes: Math.floor(n) };
      }
      return { kind: 'unknown', raw: trimmed };
    }
    case 'help':
      return { kind: 'help' };
    case 'conduit': {
      // /conduit            → 帮助
      // /conduit run        → 在当前 cwd 跑 lwa-conduit run（默认不 merge）
      // /conduit plan <spec> → 把 markdown spec 拆成 dag.yaml 工作区
      if (!tail) return { kind: 'conduit', mode: 'help' };
      const tokens = tail.split(/\s+/);
      const sub = (tokens[0] ?? '').toLowerCase();
      if (sub === 'run') {
        const rest = tokens.slice(1).join(' ').trim().toLowerCase();
        if (rest === '--merge' || rest === '-m' || rest === 'merge') {
          return { kind: 'conduit', mode: 'run-merge' };
        }
        return { kind: 'conduit', mode: 'run' };
      }
      if (sub === 'plan') {
        const spec = tokens.slice(1).join(' ').trim();
        if (!spec) return { kind: 'unknown', raw: trimmed };
        return { kind: 'conduit', mode: 'plan', spec };
      }
      if (sub === 'help' || sub === '?') return { kind: 'conduit', mode: 'help' };
      return { kind: 'unknown', raw: trimmed };
    }
    case 'ws': {
      const [sub, ...nameParts] = tail.split(/\s+/);
      const name = nameParts.join(' ').trim();
      if (sub === 'list' || sub === '' || sub === undefined) return { kind: 'ws-list' };
      if (sub === 'save' && name) return { kind: 'ws-save', name };
      if (sub === 'use' && name) return { kind: 'ws-use', name };
      if ((sub === 'remove' || sub === 'rm' || sub === 'delete') && name) {
        return { kind: 'ws-remove', name };
      }
      return { kind: 'unknown', raw: trimmed };
    }
    default:
      if (head && KIRO_INTERNAL_COMMANDS.has(head)) {
        return { kind: 'kiro-internal', name: head };
      }
      return { kind: 'unknown', raw: trimmed };
  }
}
