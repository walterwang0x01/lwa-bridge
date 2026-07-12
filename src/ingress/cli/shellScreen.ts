/**
 * LWA Code Shell 终端布局：滚动区 + 固定底栏（无 ink/blessed 依赖）。
 *
 * - 进入 alternate screen（可关）
 * - 顶部为 scroll region，底部 3 行固定状态栏
 * - readline 输入在状态栏下方自然流动
 */
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GRAY = '\x1b[90m';

export interface ShellFooter {
  primary: string;
  secondary?: string;
}

export interface ShellScreenOptions {
  /** 底栏占用行数（不含输入行） */
  footerLines?: number;
  /** 使用 alternate screen buffer */
  useAltScreen?: boolean;
  write?: (s: string) => void;
  rows?: number;
  cols?: number;
}

/** 去掉 ANSI SGR 序列（避免 regex 控制字符 lint）。 */
function stripAnsi(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x1b && text[i + 1] === '[') {
      i += 2;
      while (i < text.length && text[i] !== 'm') i++;
      continue;
    }
    out += text[i]!;
  }
  return out;
}

/** 可见宽度（去 ANSI）。 */
export function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

/** 截断到列宽，保留 ANSI 前缀无关。 */
export function truncateToCols(text: string, cols: number): string {
  if (cols < 8) return text;
  if (visibleWidth(text) <= cols) return text;
  const plain = stripAnsi(text);
  return `${plain.slice(0, cols - 1)}…`;
}

export function scrollRegionBottom(rows: number, footerLines: number): number {
  return Math.max(3, rows - footerLines - 1);
}

export function formatShellFooterLines(
  footer: ShellFooter,
  cols: number,
): { rule: string; primary: string; secondary: string } {
  const rule = `${DIM}${'─'.repeat(Math.max(20, cols))}${RESET}`;
  const primary = `${BOLD}${truncateToCols(footer.primary, cols)}${RESET}`;
  const secondary = footer.secondary
    ? `${GRAY}${truncateToCols(footer.secondary, cols)}${RESET}`
    : '';
  return { rule, primary, secondary };
}

export class ShellScreen {
  private readonly write: (s: string) => void;
  private readonly footerLines: number;
  private readonly useAltScreen: boolean;
  private active = false;
  private rows: number;
  private cols: number;
  private resizeHandler?: () => void;

  constructor(opts: ShellScreenOptions = {}) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.footerLines = opts.footerLines ?? 3;
    this.useAltScreen = opts.useAltScreen ?? true;
    this.rows = opts.rows ?? process.stdout.rows ?? 24;
    this.cols = opts.cols ?? process.stdout.columns ?? 80;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 是否适合启用全屏壳（TTY 且非 CI）。 */
  static shouldUse(opts?: { isTty?: boolean; mode?: 'code' | 'chat' }): boolean {
    const tty = opts?.isTty ?? Boolean(process.stdout.isTTY);
    if (!tty) return false;
    if (process.env['CI'] === 'true' || process.env['LWA_PLAIN_SHELL'] === '1') return false;
    return (opts?.mode ?? 'code') === 'code';
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.rows = process.stdout.rows ?? this.rows;
    this.cols = process.stdout.columns ?? this.cols;
    if (this.useAltScreen) this.write('\x1b[?1049h');
    this.applyScrollRegion();
    this.resizeHandler = () => {
      this.rows = process.stdout.rows ?? this.rows;
      this.cols = process.stdout.columns ?? this.cols;
      this.applyScrollRegion();
    };
    process.stdout.on('resize', this.resizeHandler);
  }

  exit(): void {
    if (!this.active) return;
    if (this.resizeHandler) {
      process.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
    this.write('\x1b[r');
    if (this.useAltScreen) this.write('\x1b[?1049l');
    this.active = false;
  }

  /** 在滚动区追加一行（保留换行）。 */
  appendLine(line: string): void {
    if (!line) return;
    this.write(`${line}\n`);
  }

  /** 在滚动区追加多行文本。 */
  appendBlock(text: string): void {
    const body = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!body) return;
    this.write(body.endsWith('\n') ? body : `${body}\n`);
  }

  /** 绘制固定底栏（不移动 readline 光标）。 */
  renderFooter(footer: ShellFooter): void {
    const { rule, primary, secondary } = formatShellFooterLines(footer, this.cols);
    const startRow = this.rows - this.footerLines + 1;
    this.write('\x1b[s');
    this.write(`\x1b[${startRow};1H\x1b[2K${rule}`);
    this.write(`\x1b[${startRow + 1};1H\x1b[2K${primary}`);
    this.write(`\x1b[${startRow + 2};1H\x1b[2K${secondary}`);
    this.write('\x1b[u');
  }

  /** 启动横幅（滚动区内）。 */
  renderBanner(title: string, hint: string): void {
    const { rule } = formatShellFooterLines({ primary: '' }, this.cols);
    this.appendLine(rule);
    this.appendLine(title);
    this.appendLine(hint);
    this.appendLine(rule);
  }

  private applyScrollRegion(): void {
    const bottom = scrollRegionBottom(this.rows, this.footerLines);
    this.write(`\x1b[1;${bottom}r`);
    this.write(`\x1b[1;1H`);
  }
}
