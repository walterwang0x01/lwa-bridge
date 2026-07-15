/**
 * Docked 模式实时输入：敲 `/` 立刻弹出命令菜单（不必先回车）。
 * ↑↓ 选择 · Tab 补全 · Enter 确认 · Esc 关菜单。
 *
 * 输入画在固定高度 pane 内（可多行），与最底状态栏隔离 —— 对齐 Cursor 分区布局。
 */
import { accent, muted, paint, T, shellPrompt, formatInputPaneLine } from './theme.js';
import {
  displayWidth,
  graphemeWidth,
  splitGraphemes,
  stripAnsi,
  takeDisplayTail,
  truncateDisplay,
} from './terminalWidth.js';
import { listSlashCommands, type SlashCommandItem } from './slashPicker.js';
import {
  contentBottomRow,
  DEFAULT_INPUT_PANE_HEIGHT,
  inputPaneTopRow,
  type ShellScreen,
} from './shellScreen.js';

export function filterSlashCommands(cmds: SlashCommandItem[], typed: string): SlashCommandItem[] {
  const q = typed.trim().toLowerCase();
  if (!q || q === '/') return cmds;
  return cmds.filter(
    (c) => c.cmd.toLowerCase().startsWith(q) || c.cmd.toLowerCase().includes(q.slice(1)),
  );
}

export function isPrintableInput(key: string): boolean {
  if (!key) return false;
  if (key.startsWith('\u001b')) return false;
  if (key === '\r' || key === '\n' || key === '\t') return false;
  if (key === '\x7f' || key === '\b' || key === '\u0003') return false;
  for (const ch of key) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) return false;
  }
  return true;
}

export function backspaceBuffer(buffer: string): string {
  if (!buffer) return '';
  const graphemes = splitGraphemes(buffer);
  graphemes.pop();
  return graphemes.join('');
}

export function inputDisplayWidth(s: string): number {
  return displayWidth(s);
}

export function fitInputToCols(promptVisible: number, buffer: string, cols: number): string {
  const budget = Math.max(4, cols - promptVisible - 1);
  return takeDisplayTail(buffer, budget);
}

/**
 * 把 prompt+buffer 折进固定高度输入 pane（Cursor 式：换行不出框）。
 * buffer 内 `\n` 视为硬换行（由 `\⏎` 插入）。
 */
export function wrapInputPane(opts: {
  promptPlain: string;
  buffer: string;
  cols: number;
  maxLines: number;
}): { lines: string[]; cursorLine: number; cursorCol: number; totalLines: number } {
  const { promptPlain, buffer, cols, maxLines } = opts;
  const maxWidth = Math.max(8, cols);
  const all: string[] = [];
  let line = promptPlain;
  let lineW = inputDisplayWidth(promptPlain);

  const breakLine = () => {
    all.push(line);
    line = '';
    lineW = 0;
  };

  const pushGrapheme = (grapheme: string) => {
    if (grapheme === '\n') {
      breakLine();
      return;
    }
    const graphemeColumns = graphemeWidth(grapheme);
    if (lineW + graphemeColumns > maxWidth) breakLine();
    line += grapheme;
    lineW += graphemeColumns;
  };

  for (const grapheme of splitGraphemes(buffer)) pushGrapheme(grapheme);
  all.push(line);

  const cursorLine = all.length - 1;
  const cursorCol = 1 + inputDisplayWidth(all[cursorLine] ?? '');
  const totalLines = all.length;

  if (all.length > maxLines) {
    const skip = all.length - maxLines;
    return {
      lines: all.slice(skip),
      cursorLine: cursorLine - skip,
      cursorCol,
      totalLines,
    };
  }
  return { lines: all, cursorLine, cursorCol, totalLines };
}

/** 多行输入时 pane 高度：最少 3，随内容升高，上限随终端高度。 */
export function desiredInputPaneHeight(totalLines: number, termRows: number): number {
  const min = DEFAULT_INPUT_PANE_HEIGHT;
  const max = Math.min(10, Math.max(min, Math.floor(termRows / 3)));
  return Math.min(max, Math.max(min, totalLines));
}

const INPUT_CONT_INDENT = '  ';
export const INPUT_PLACEHOLDER = 'Ask LWA to build, debug, or explain…';
export const CLI_INTERRUPT_VALUE = '.exit';

/** 把 wrapped 行转成可绘制文本（仅首行带 prompt，续行缩进）。 */
export function formatInputPaneDisplayLine(
  rawLine: string | undefined,
  promptPlain: string,
  promptStyled: string,
  lineIndex: number,
  placeholderStyled = '',
): string {
  if (!rawLine) return lineIndex === 0 ? `${promptStyled}${placeholderStyled}` : '';
  if (rawLine.startsWith(promptPlain)) {
    const body = rawLine.slice(promptPlain.length);
    return `${promptStyled}${body || placeholderStyled}`;
  }
  return `${INPUT_CONT_INDENT}${rawLine}`;
}

export type InputPanePaint = {
  pane: number;
  /** 屏幕行号 → 纯文本（无底色 ANSI） */
  lines: Array<{ screenRow: number; plain: string }>;
  cursor: { screenRow: number; col: number };
};

/** 可测试的输入 pane 布局（与 paintInput 同源逻辑）。 */
export function buildInputPanePaint(opts: {
  buffer: string;
  cols: number;
  termRows: number;
  pane?: number;
}): InputPanePaint {
  const promptPlain = '❯ ';
  const { cols, termRows } = opts;
  const measured = wrapInputPane({ promptPlain, buffer: opts.buffer, cols, maxLines: 999 });
  const pane = opts.pane ?? desiredInputPaneHeight(measured.totalLines, termRows);
  const wrapped = wrapInputPane({ promptPlain, buffer: opts.buffer, cols, maxLines: pane });
  const top = inputPaneTopRow(termRows, pane);
  const lines: InputPanePaint['lines'] = [];
  for (let i = 0; i < pane; i++) {
    const plain = stripAnsi(
      formatInputPaneDisplayLine(wrapped.lines[i], promptPlain, '❯ ', i, INPUT_PLACEHOLDER),
    );
    lines.push({ screenRow: top + i, plain });
  }
  const curRow = top + Math.min(Math.max(0, wrapped.cursorLine), pane - 1);
  return {
    pane,
    lines,
    cursor: { screenRow: curRow, col: Math.min(cols, Math.max(1, wrapped.cursorCol)) },
  };
}

/** 模拟按键序列（单元测试 / 冒烟脚本用）。 */
export function simulateLiveInputKeys(
  keys: Array<string | '\r' | '\n' | '\b'>,
  init = '',
): { buffer: string; submitted?: string } {
  let buffer = init;
  for (const key of keys) {
    if (key === '\u0003') {
      return { buffer, submitted: CLI_INTERRUPT_VALUE };
    }
    if (key === '\r' || key === '\n') {
      const d = applyEnterKey(buffer);
      if ('next' in d) buffer = d.next;
      else return { buffer, submitted: d.submit };
    } else if (key === '\b') {
      buffer = backspaceBuffer(buffer);
    } else {
      buffer += key;
    }
  }
  return { buffer };
}

/** `\` + Enter → 换行；否则提交。 */
export function applyEnterKey(buffer: string): { submit: string } | { next: string } {
  if (buffer.endsWith('\\') && !buffer.endsWith('\\\\')) {
    return { next: `${buffer.slice(0, -1)}\n` };
  }
  // 提交时去掉行续尾部空白行
  return { submit: buffer.replace(/\n+$/g, '') };
}

function geom(shell: ShellScreen | null): { rows: number; cols: number; pane: number } {
  return {
    rows: shell?.termRows ?? process.stdout.rows ?? 24,
    cols: shell?.termCols ?? process.stdout.columns ?? 80,
    pane: shell?.paneHeight ?? DEFAULT_INPUT_PANE_HEIGHT,
  };
}

function visibleLen(s: string): number {
  return displayWidth(s);
}

function truncatePlain(s: string, cols: number): string {
  return truncateDisplay(s, cols);
}

function writeRaw(shell: ShellScreen | null, s: string): void {
  if (shell?.isDocked) shell.writePassthrough(s);
  else process.stdout.write(s);
}

export async function readLiveLine(opts: {
  shell: ShellScreen | null;
  mode: 'code' | 'chat';
  fallbackAsk: (prompt: string) => Promise<string>;
  pauseReadline?: () => void;
  resumeReadline?: () => void;
}): Promise<string> {
  // docked + 能 setRawMode 就走 live（不依赖 stdin.isTTY：PyCharm 等会报假阴性）
  const canRaw = typeof process.stdin.setRawMode === 'function';
  const canLive = Boolean(canRaw && process.stdout.isTTY && opts.shell?.isDocked);
  if (!canLive) {
    if (opts.shell?.isDocked) opts.shell.suspendIngest(true);
    try {
      return (await opts.fallbackAsk(shellPrompt())).replace(/^\s+/, '').replace(/\n+$/g, '');
    } finally {
      if (opts.shell?.isDocked) opts.shell.suspendIngest(false);
    }
  }

  opts.pauseReadline?.();
  const shell = opts.shell!;
  shell.suspendChromeRepaint(true);
  shell.suspendIngest(true);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  const allCmds = listSlashCommands(opts.mode);
  let buffer = '';
  let menuIdx = 0;
  let menuOpen = false;

  let { rows, cols, pane } = geom(shell);

  const clearMenu = (): void => {
    menuOpen = false;
    shell.clearMenuOverlay();
  };

  const paintInput = (): void => {
    const prompt = shellPrompt();
    const promptPlain = '❯ ';
    const measured = wrapInputPane({
      promptPlain,
      buffer,
      cols,
      maxLines: 999,
    });
    const needed = desiredInputPaneHeight(measured.totalLines, rows);
    if (shell.setPaneHeight(needed)) {
      pane = needed;
    } else {
      pane = shell.paneHeight;
    }
    const wrapped = wrapInputPane({ promptPlain, buffer, cols, maxLines: pane });
    const top = inputPaneTopRow(rows, pane);
    shell.clearInputPane();
    writeRaw(shell, '\x1b[?25l');
    for (let i = 0; i < pane; i++) {
      const row = top + i;
      const text = formatInputPaneDisplayLine(
        wrapped.lines[i],
        promptPlain,
        prompt,
        i,
        muted(INPUT_PLACEHOLDER),
      );
      writeRaw(shell, `\x1b[${row};1H\x1b[2K${formatInputPaneLine(text, cols, { colored: true })}`);
    }
    shell.repaintStatus();
    const curRow = top + Math.min(Math.max(0, wrapped.cursorLine), pane - 1);
    const curCol = Math.min(cols, Math.max(1, wrapped.cursorCol));
    writeRaw(shell, `\x1b[${curRow};${curCol}H\x1b[?25h`);
  };

  const paintMenu = (items: SlashCommandItem[]): void => {
    const bottom = contentBottomRow(rows, pane);
    const maxShow = Math.min(items.length, Math.max(3, bottom - 3));
    let start = 0;
    if (items.length > maxShow) {
      const half = Math.floor(maxShow / 2);
      start = Math.max(0, Math.min(menuIdx - half, items.length - maxShow));
    }
    const show = items.slice(start, start + maxShow);
    const header = muted('↑↓ · Tab complete · Enter · Esc');
    const block: string[] = [header];
    if (start > 0) block.push(muted(`  ↑ ${start} more`));
    for (let i = 0; i < show.length; i++) {
      const abs = start + i;
      const it = show[i]!;
      const on = abs === menuIdx;
      const mark = on ? accent('❯ ') : '  ';
      const lab = on ? paint(T.bold + T.text, it.cmd) : it.cmd;
      const hint = it.hint ? muted(`  ${it.hint}`) : '';
      let line = `${mark}${lab}${hint}`;
      if (visibleLen(line) > cols - 1) {
        const plain = truncatePlain(`${on ? '❯ ' : '  '}${it.cmd}`, cols - 1);
        line = on ? accent(plain) : plain;
      }
      block.push(line);
    }
    if (start + show.length < items.length) {
      block.push(muted(`  ↓ ${items.length - start - show.length} more`));
    }
    menuOpen = true;
    shell.setMenuOverlay(block);
    paintInput();
  };

  const refreshMenu = (): void => {
    if (!buffer.startsWith('/')) {
      if (menuOpen) {
        clearMenu();
        paintInput();
      }
      return;
    }
    const items = filterSlashCommands(allCmds, buffer);
    if (!items.length) {
      clearMenu();
      paintInput();
      return;
    }
    if (menuIdx >= items.length) menuIdx = items.length - 1;
    if (menuIdx < 0) menuIdx = 0;
    paintMenu(items);
  };

  const finish = (value: string): string => {
    clearMenu();
    writeRaw(shell, '\x1b[?25h');
    shell.setPaneHeight(DEFAULT_INPUT_PANE_HEIGHT);
    shell.suspendIngest(false);
    shell.suspendChromeRepaint(false);
    shell.afterInput();
    return value;
  };

  try {
    if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
    stdin.setRawMode?.(true);
    stdin.resume();
    shell.focusInput();
    paintInput();

    return await new Promise<string>((resolve) => {
      const onData = (chunk: string | Buffer) => {
        const key = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (!key) return;

        if (key === '\u0003') {
          cleanup();
          resolve(finish(CLI_INTERRUPT_VALUE));
          return;
        }

        if (key === '\u001b') {
          if (menuOpen) {
            clearMenu();
            if (buffer === '/') buffer = '';
            paintInput();
            return;
          }
          buffer = '';
          paintInput();
          return;
        }

        if (key === '\r' || key === '\n') {
          const decision = applyEnterKey(buffer);
          if ('next' in decision) {
            buffer = decision.next;
            // 多行时关掉 slash 菜单，避免浮层把输入挤没
            if (menuOpen) clearMenu();
            paintInput();
            return;
          }
          const items = filterSlashCommands(allCmds, buffer);
          let out = decision.submit;
          if (menuOpen && items[menuIdx] && !buffer.includes('\n')) {
            out = items[menuIdx]!.insert;
          }
          cleanup();
          resolve(finish(out.replace(/^\s+/, '').replace(/\n+$/g, '')));
          return;
        }

        if (key === '\t') {
          const items = filterSlashCommands(allCmds, buffer);
          if (items[menuIdx]) {
            buffer = items[menuIdx]!.insert;
            menuIdx = 0;
            paintInput();
            refreshMenu();
          }
          return;
        }

        if (key === '\x7f' || key === '\b') {
          buffer = backspaceBuffer(buffer);
          paintInput();
          refreshMenu();
          return;
        }

        if (key === '\u001b[A') {
          if (menuOpen) {
            const items = filterSlashCommands(allCmds, buffer);
            menuIdx = (menuIdx - 1 + items.length) % Math.max(items.length, 1);
            paintMenu(items);
          }
          return;
        }
        if (key === '\u001b[B') {
          if (menuOpen) {
            const items = filterSlashCommands(allCmds, buffer);
            menuIdx = (menuIdx + 1) % Math.max(items.length, 1);
            paintMenu(items);
          }
          return;
        }
        if (key.startsWith('\u001b')) return;

        if (isPrintableInput(key)) {
          buffer += key;
          if (buffer.startsWith('/')) menuIdx = 0;
          paintInput();
          refreshMenu();
        }
      };

      const onResize = () => {
        ({ rows, cols, pane } = geom(shell));
        if (menuOpen) refreshMenu();
        else paintInput();
      };

      const cleanup = () => {
        stdin.off('data', onData);
        process.stdout.off('resize', onResize);
        try {
          stdin.setRawMode?.(wasRaw ?? false);
        } catch {
          // ignore
        }
      };

      process.stdout.on('resize', onResize);
      stdin.on('data', onData);
    });
  } catch (e) {
    writeRaw(shell, '\x1b[?25h');
    shell.suspendIngest(false);
    shell.suspendChromeRepaint(false);
    throw e;
  } finally {
    opts.resumeReadline?.();
  }
}
