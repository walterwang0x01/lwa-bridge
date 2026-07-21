/**
 * CLI 交互式斜杠菜单 / 列表选择（对齐 Cursor：↑↓ + Enter，Esc 取消）。
 * Docked 下用绝对行号 + 可视窗口绘制，避免长列表把 Auto/cursor 滚出屏幕。
 */
import { createInterface } from 'node:readline';
import { accent, muted, paint, T } from './theme.js';
import { displayWidth, truncateDisplay } from './terminalWidth.js';
import { cliWrite, contentBottomRow, getActiveShell, inputPaneTopRow } from './shellScreen.js';

export interface SlashCommandItem {
  /** 展示名，如 /model */
  cmd: string;
  /** 一行说明 */
  hint: string;
  /** 选中后注入到 REPL 的文本；空表示仅展示提示 */
  insert: string;
}

/** 常用斜杠命令（打 `/` 时弹出） */
export function listSlashCommands(mode: 'code' | 'chat' = 'code'): SlashCommandItem[] {
  const common: SlashCommandItem[] = [
    { cmd: '/model', hint: 'Pick Auto / cursor / kiro / gateway', insert: '/model' },
    { cmd: '/runtime', hint: 'Select engine · auto clears sticky', insert: '/runtime' },
    { cmd: '/runtime auto', hint: 'Re-enable Auto routing', insert: '/runtime auto' },
    { cmd: '/yolo', hint: 'Toggle Run Everything', insert: '/yolo' },
    { cmd: '/status', hint: 'Status bar details', insert: '/status' },
    { cmd: '/doctor', hint: 'Local checkup', insert: '/doctor' },
    { cmd: '/help', hint: 'Full command list', insert: '/help' },
    { cmd: '/sessions', hint: 'List sessions', insert: '/sessions' },
    { cmd: '/new', hint: 'New session id', insert: '/new' },
    { cmd: '/clear', hint: 'Clear summary (keep id)', insert: '/clear' },
    { cmd: '/stop', hint: 'Abort running task', insert: '/stop' },
    { cmd: '/pwd', hint: 'Show cwd', insert: '/pwd' },
    { cmd: '/cd', hint: 'Change directory', insert: '/cd ' },
    { cmd: '/ws list', hint: 'Named workspaces', insert: '/ws list' },
    { cmd: '/worktree list', hint: 'Git worktrees', insert: '/worktree list' },
    { cmd: '/jobs', hint: 'Parallel jobs', insert: '/jobs' },
    { cmd: '/conduit', hint: 'Spec → DAG → parallel run', insert: '/conduit' },
    { cmd: '/conduit plan', hint: 'spec.md → dag.yaml', insert: '/conduit plan ' },
    { cmd: '/conduit run', hint: 'Execute dag.yaml (no merge)', insert: '/conduit run' },
    { cmd: '/conduit status', hint: 'Wave / tasks', insert: '/conduit status' },
    { cmd: '/compact', hint: 'Compress context', insert: '/compact' },
    { cmd: '/config', hint: 'Show config (read-only in CLI)', insert: '/config' },
    { cmd: '/ps', hint: 'Bridge processes', insert: '/ps' },
  ];
  if (mode === 'code') {
    common.splice(
      5,
      0,
      { cmd: '/plan', hint: 'Plan phase (no edits)', insert: '/plan' },
      { cmd: '/apply', hint: 'Apply / implement', insert: '/apply' },
      { cmd: '/review', hint: 'Review phase', insert: '/review' },
    );
  }
  return common;
}

export interface PickListItem {
  value: string;
  label: string;
  hint?: string;
}

export interface CliInteract {
  ask: (prompt: string) => Promise<string>;
  pauseReadline?: () => void;
  resumeReadline?: () => void;
}

let interact: CliInteract | null = null;

export function setCliInteract(next: CliInteract | null): void {
  interact = next;
}

export function getCliInteract(): CliInteract | null {
  return interact;
}

function write(s: string): void {
  cliWrite(s);
}

function visibleLen(s: string): number {
  return displayWidth(s);
}

function truncatePlain(s: string, cols: number): string {
  return truncateDisplay(s, cols);
}

/** 无 TTY 时退化为编号 + ask 一行。 */
async function pickByNumber(
  title: string,
  items: PickListItem[],
  ask: (p: string) => Promise<string>,
): Promise<string | null> {
  const lines = [title, ''];
  items.forEach((it, i) => {
    const hint = it.hint ? muted(`  ${it.hint}`) : '';
    lines.push(`  ${paint(T.brandBright, String(i + 1).padStart(2))}  ${it.label}${hint}`);
  });
  lines.push('', muted('type number / value · Enter cancel'));
  write(`${lines.join('\n')}\n`);
  getActiveShell()?.focusInput();
  const ans = (await ask(accent('select › '))).trim();
  getActiveShell()?.afterInput();
  if (!ans) return null;
  const n = Number(ans);
  if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!.value;
  const byValue = items.find((it) => it.value === ans || it.label === ans);
  return byValue?.value ?? ans;
}

/** 计算列表可视窗口起点，保证 idx 落在窗口内。 */
export function windowStart(idx: number, total: number, maxShow: number): number {
  if (total <= maxShow) return 0;
  const half = Math.floor(maxShow / 2);
  let start = idx - half;
  if (start < 0) start = 0;
  if (start + maxShow > total) start = total - maxShow;
  return start;
}

/**
 * ↑↓ / j k 移动，Enter 确认，Esc / q 取消。
 * Docked：绝对定位在输入行上方，带滚动窗口。
 */
export async function pickFromList(opts: {
  title: string;
  items: PickListItem[];
}): Promise<string | null> {
  const { title, items } = opts;
  if (!items.length) return null;

  const canRaw =
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && Boolean(interact?.pauseReadline);

  if (!canRaw || !interact) {
    if (!interact) {
      write(`${title}\n${muted('(non-interactive — type full command, e.g. /model <name>)')}\n`);
      return null;
    }
    return pickByNumber(title, items, interact.ask);
  }

  interact.pauseReadline?.();
  const shell = getActiveShell();
  shell?.suspendChromeRepaint(true);
  // 挂起内容重绘摄入：pickFromList 用 writePassthrough 直接画菜单，不经过 menuOverlay，
  // 若渲染期间任何异步写入触发了 ShellScreen 的 30ms 防抖重绘，会把菜单整体覆盖清空
  // （表现为"菜单有时不显示"）。挂起后台摄入即可避免这次竞态。
  shell?.suspendIngest(true);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  let idx = 0;
  let closed = false;
  let paintedLines = 0;
  const rows = shell?.termRows ?? process.stdout.rows ?? 24;
  const cols = shell?.termCols ?? process.stdout.columns ?? 80;
  const docked = Boolean(shell?.isDocked);

  const clearDocked = (): void => {
    if (!docked || paintedLines <= 0) return;
    paintedLines = 0;
    shell?.redrawContent();
  };

  const render = (): void => {
    const header = muted('↑↓ move · Enter select · Esc cancel');
    const reserve = 3; // title + hint + optional more
    const bottom = contentBottomRow(rows);
    const maxBody = docked
      ? Math.max(4, Math.min(items.length, bottom - 3))
      : Math.max(4, Math.min(items.length, (process.stdout.rows ?? 24) - 6));
    const start = windowStart(idx, items.length, maxBody);
    const show = items.slice(start, start + maxBody);
    const moreTop = start > 0 ? muted(`  ↑ ${start} more`) : null;
    const moreBot =
      start + show.length < items.length
        ? muted(`  ↓ ${items.length - (start + show.length)} more`)
        : null;

    if (docked) {
      clearDocked();
      const block: string[] = [paint(T.bold + T.brandBright, title), header];
      if (moreTop) block.push(moreTop);
      for (let i = 0; i < show.length; i++) {
        const abs = start + i;
        const it = show[i]!;
        const on = abs === idx;
        const mark = on ? accent('❯ ') : '  ';
        const lab = on ? paint(T.bold + T.text, it.label) : it.label;
        const hint = it.hint ? muted(`  ${it.hint}`) : '';
        let line = `${mark}${lab}${hint}`;
        if (visibleLen(line) > cols - 1) {
          line = truncatePlain(`${on ? '❯ ' : '  '}${it.label}`, cols - 1);
          if (on) line = accent(line);
        }
        block.push(line);
      }
      if (moreBot) block.push(moreBot);
      const paintStart = Math.max(1, bottom - block.length + 1);
      for (let i = 0; i < block.length; i++) {
        shell!.writePassthrough(`\x1b[${paintStart + i};1H\x1b[2K${block[i]}`);
      }
      paintedLines = block.length;
      // 保持输入行空白，避免和菜单粘在一起
      shell!.writePassthrough(`\x1b[${inputPaneTopRow(rows)};1H\x1b[2K`);
      void reserve;
      return;
    }

    // soft / plain：相对光标重绘
    if (paintedLines > 0) {
      write(`\x1b[${paintedLines}A\x1b[0J`);
    }
    const lines: string[] = ['', paint(T.bold + T.brandBright, title), header, ''];
    if (moreTop) lines.push(moreTop);
    for (let i = 0; i < show.length; i++) {
      const abs = start + i;
      const it = show[i]!;
      const on = abs === idx;
      const mark = on ? accent('❯ ') : '  ';
      const lab = on ? paint(T.bold + T.text, it.label) : it.label;
      const hint = it.hint ? muted(`  ${it.hint}`) : '';
      lines.push(`${mark}${lab}${hint}`);
    }
    if (moreBot) lines.push(moreBot);
    lines.push('');
    write(`${lines.join('\n')}`);
    paintedLines = lines.length;
  };

  try {
    // Node 内部的 readline.emitKeypressEvents（this.rl 构造时自动挂载）在 stdin
    // 上注册了一个自己的 'data' 处理器，用来把原始字节解析成 'keypress' 事件。
    // 这个处理器内部会检查 `stdin.listenerCount('keypress') > 0`——如果之前我们
    // 移除了所有 keypress 监听器，它会认为"没人关心"，处理逻辑不完整/跳过，导致
    // 多字节转义序列（方向键等 CSI 序列）被这个内部处理器消费掉但从未真正传播给
    // 我们自己的 'data' 监听器（这是方向键在 /model 等菜单里完全无响应的真正根因，
    // 见 PROGRESS.md 里的完整调查记录）。close()/off 也无法阻止这个内部处理器，
    // Node 文档明确写了"closing the readline instance does not stop keypress"。
    // 正确做法：不要清空 keypress 监听器数量到 0，而是保留一个空操作的占位监听器，
    // 让内部处理器认为"有人在听"，从而完整地处理并传播原始字节到 'data' 事件。
    const noopKeypress = () => {};
    stdin.on('keypress', noopKeypress);
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    return await new Promise<string | null>((resolve) => {
      // onData 必须在 render() 之前注册：render() 之后到 stdin.on('data', onData)
      // 真正执行之间存在一个真实的时间窗口（哪怕只是几个微任务的间隙），如果用户
      // 按键恰好落在这个窗口里，Node 内部的按键解析器会独自处理并消费掉这些字节
      // （因为此时它是唯一的 'data' 监听器），我们自己的 onData 完全收不到——
      // 这正是 /model 等菜单里"按方向键完全无响应"的真正根因（详见上面 keypress
      // 注释和 PROGRESS.md 里的完整调查记录）。
      const onData = (key: string) => {
        if (closed) return;
        if (key === '\u0003') {
          cleanup();
          resolve(null);
          return;
        }
        // 整包 Esc；方向键是 \u001b[A 不会进这里
        if (key === '\u001b' || key === 'q') {
          cleanup();
          if (!docked) write(`${muted('cancelled')}\n`);
          resolve(null);
          return;
        }
        if (key === '\r' || key === '\n') {
          const v = items[idx]!.value;
          cleanup();
          if (!docked) write(`${accent('❯')} ${items[idx]!.label}\n`);
          else shell?.writePassthrough(`\n${accent('❯')} ${items[idx]!.label}\n`);
          resolve(v);
          return;
        }
        if (key === '\u001b[A' || key === 'k') {
          idx = (idx - 1 + items.length) % items.length;
          render();
          return;
        }
        if (key === '\u001b[B' || key === 'j') {
          idx = (idx + 1) % items.length;
          render();
          return;
        }
        if (key.startsWith('\u001b')) return;
        if (/^[1-9]$/.test(key)) {
          const n = Number(key);
          if (n >= 1 && n <= Math.min(9, items.length)) {
            idx = n - 1;
            render();
          }
        }
      };

      const cleanup = () => {
        closed = true;
        stdin.off('data', onData);
        stdin.off('keypress', noopKeypress);
        try {
          stdin.setRawMode?.(wasRaw ?? false);
        } catch {
          // ignore
        }
        clearDocked();
      };

      stdin.on('data', onData);
      render();
    });
  } finally {
    shell?.suspendChromeRepaint(false);
    shell?.suspendIngest(false);
    interact.resumeReadline?.();
    shell?.afterInput();
  }
}

export async function pickSlashCommand(mode: 'code' | 'chat'): Promise<string | null> {
  const cmds = listSlashCommands(mode);
  const selected = await pickFromList({
    title: 'Slash commands',
    items: cmds.map((c) => ({
      value: c.insert,
      label: c.cmd,
      hint: c.hint,
    })),
  });
  return selected;
}

/** 用临时 readline 提问（当 channel 已 pause 自己的 rl 时仍可用） */
export async function askLineFallback(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (ans) => resolve(ans));
    });
  } finally {
    rl.close();
  }
}
