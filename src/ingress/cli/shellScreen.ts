/**
 * LWA Code Shell 布局（对齐 Cursor：输入区与底栏分区，互不覆盖）：
 *   上：滚动内容区
 *   中：固定高度输入 pane（多行；宽字符换行也出不去）
 *   下：固定 1 行状态栏
 *
 * 回退：LWA_PLAIN_SHELL=1
 */
import { formatDockedStatusLine, formatInputPaneLine, formatShellBanner } from './theme.js';
import { displayWidth, truncateDisplay } from './terminalWidth.js';

export interface ShellFooter {
  primary: string;
  secondary?: string;
  approval?: string;
}

export interface ShellScreenOptions {
  write?: (s: string) => void;
  rows?: number;
  cols?: number;
  docked?: boolean;
  inputPaneHeight?: number;
}

export function visibleWidth(text: string): number {
  return displayWidth(text);
}

/**
 * 返回 value（若为正数），否则返回 fallback。
 *
 * 用于 process.stdout.rows/columns：这两个值在部分终端环境下会上报为 0（而非
 * undefined），例如 SSH 会话刚建立、某些伪终端实现。`value ?? fallback` 只在
 * value 是 null/undefined 时才生效，0 会直接通过并导致布局计算（分区高度、
 * 光标定位）全部失效，界面表现为静默无响应（无渲染、无报错）。
 */
export function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function truncateToCols(text: string, cols: number): string {
  if (cols < 8) return text;
  return truncateDisplay(text, cols);
}

/** 输入 pane 默认高度（不含最底状态行）；内容换行时动态增长。 */
export const DEFAULT_INPUT_PANE_HEIGHT = 1;

export function contentBottomRow(rows: number, inputPane = DEFAULT_INPUT_PANE_HEIGHT): number {
  return Math.max(1, rows - inputPane - 1);
}

export function inputPaneTopRow(rows: number, inputPane = DEFAULT_INPUT_PANE_HEIGHT): number {
  return Math.max(1, rows - inputPane);
}

/** @deprecated 兼容旧调用 → 输入 pane 顶行 */
export function inputRow(rows: number, inputPane = DEFAULT_INPUT_PANE_HEIGHT): number {
  return inputPaneTopRow(rows, inputPane);
}

export function statusRow(rows: number): number {
  return Math.max(1, rows);
}

export type ContentLayoutMode = 'welcome' | 'conversation';

/**
 * 将内容映射为固定高度视口；欢迎区位于上三分之一，会话内容保持贴底。
 *
 * scrollOffset：从底部往上偏移的行数（0 = 贴底显示最新内容，正数 = 往上翻看
 * 历史）。上限由调用方通过 clampScrollOffset() 计算，这里只负责按给定
 * offset 截取对应窗口，不做边界收敛。
 */
export function layoutContentViewport(opts: {
  lines: string[];
  height: number;
  mode: ContentLayoutMode;
  scrollOffset?: number;
}): string[] {
  const height = Math.max(0, Math.floor(opts.height));
  if (height === 0) return [];
  const offset = Math.max(0, Math.floor(opts.scrollOffset ?? 0));
  const end = offset > 0 ? Math.max(0, opts.lines.length - offset) : opts.lines.length;
  const start = Math.max(0, end - height);
  const visible = opts.lines.slice(start, end);
  const freeRows = Math.max(0, height - visible.length);
  const topPadding =
    opts.mode === 'welcome' ? Math.min(freeRows, Math.max(1, Math.floor(height * 0.22))) : freeRows;
  const bottomPadding = freeRows - topPadding;
  return [
    ...Array.from({ length: topPadding }, () => ''),
    ...visible,
    ...Array.from({ length: bottomPadding }, () => ''),
  ];
}

/**
 * 计算合法的 scrollOffset 上限：最多能往上翻到"第一屏刚好铺满历史开头"，
 * 不能翻出比 totalLines 更早的不存在内容。totalLines <= height 时（内容还
 * 没超出一屏）上限为 0——没有可翻的历史。
 */
export function clampScrollOffset(offset: number, totalLines: number, height: number): number {
  const maxOffset = Math.max(0, totalLines - height);
  return Math.max(0, Math.min(Math.floor(offset), maxOffset));
}

type StdoutWrite = typeof process.stdout.write;

export class ShellScreen {
  private readonly writeFn: (s: string) => void;
  private readonly docked: boolean;
  private inputPaneHeight: number;
  private active = false;
  private rows: number;
  private cols: number;
  private resizeHandler?: () => void;
  private lastFooter: ShellFooter = { primary: '' };
  private bannerPrinted = false;
  private paintingChrome = false;
  private repaintSuspended = false;
  private originalStdoutWrite: StdoutWrite | null = null;
  private chromeRepaintTimer: ReturnType<typeof setTimeout> | null = null;
  /** 会话内 transcript：避免 DECSTBM 把滚出内容丢掉（Cursor 用虚拟列表同理） */
  private transcript: string[] = [];
  private openLine = '';
  private contentRedrawTimer: ReturnType<typeof setTimeout> | null = null;
  /** streaming patch 起点（transcript 下标） */
  private streamBlockStart = -1;
  /** 嵌套 chrome 深度：避免 clear/paint 交错时提前关掉标志 */
  private chromeDepth = 0;
  /** 输入期：stdout 不进 transcript（防 /model 叠字鬼影） */
  private ingestSuspended = false;
  /** slash 菜单浮层（内容区底部，不进 transcript） */
  private menuOverlay: string[] = [];
  /** 首屏 hero 独立于会话 transcript，保留品牌 ANSI 样式。 */
  private welcomeLines: string[] = [];
  private welcomeActive = false;
  /** 历史滚动：0 = 贴底跟随最新；正数 = 往上翻看历史（PageUp/PageDown）。 */
  private scrollOffset = 0;
  /** 滚动查看历史期间，新内容到达但未显示——用于状态栏"有新消息"提示。 */
  private hasNewContentWhileScrolled = false;

  constructor(opts: ShellScreenOptions = {}) {
    this.docked = opts.docked ?? process.env['LWA_PLAIN_SHELL'] !== '1';
    this.inputPaneHeight = Math.max(1, opts.inputPaneHeight ?? DEFAULT_INPUT_PANE_HEIGHT);
    // process.stdout.rows/columns 在某些终端环境下会短暂或持续上报为 0（而不是
    // undefined），例如 SSH 会话刚建立、部分伪终端实现；`?? 24` 这种写法只在值是
    // null/undefined 时才生效，0 会直接通过，导致后续所有布局计算（光标定位、
    // 分区高度）失效，界面静默无响应。用 positiveOr() 同时防御 0 和 NaN。
    this.rows = positiveOr(opts.rows, positiveOr(process.stdout.rows, 24));
    this.cols = positiveOr(opts.cols, positiveOr(process.stdout.columns, 80));
    this.writeFn =
      opts.write ??
      ((s) => {
        if (this.originalStdoutWrite) this.originalStdoutWrite(s);
        else process.stdout.write(s);
      });
  }

  get isActive(): boolean {
    return this.active;
  }

  get isDocked(): boolean {
    return this.active && this.docked;
  }

  get termRows(): number {
    return this.rows;
  }

  get termCols(): number {
    return this.cols;
  }

  get paneHeight(): number {
    return this.inputPaneHeight;
  }

  /**
   * 多行输入时动态升高 pane（Cursor 同理）；变高会重绘内容区贴底布局。
   * @returns 是否发生高度变化
   */
  setPaneHeight(n: number): boolean {
    const next = Math.max(1, Math.min(12, Math.floor(n)));
    if (next === this.inputPaneHeight) return false;
    const oldTop = inputPaneTopRow(this.rows, this.inputPaneHeight);
    this.inputPaneHeight = next;
    if (this.isDocked) {
      this.paintContentViewport();
      // pane 变高时，原内容区底行可能残留旧字，先擦掉再铺灰底
      const newTop = inputPaneTopRow(this.rows, this.inputPaneHeight);
      if (newTop < oldTop) {
        for (let r = newTop; r < oldTop; r++) {
          this.writePassthrough(`\x1b[${r};1H\x1b[2K`);
        }
      }
      this.clearInputPane();
      this.repaintStatus();
    }
    return true;
  }

  get isAltScreen(): boolean {
    return this.isDocked;
  }

  suspendChromeRepaint(on: boolean): void {
    this.repaintSuspended = on;
    if (on) this.cancelChromeRepaint();
  }

  /** 输入期间挂起 transcript 摄入，避免误写把 prompt 叠进内容区 */
  suspendIngest(on: boolean): void {
    this.ingestSuspended = on;
    if (on) {
      // cancelContentRedraw() 会取消掉任何排队中的 30ms 防抖重绘。如果这次
      // 取消发生在一个尚未执行的窗口内，之前 write() 写入 transcript 的内容
      // 会被永久卡住不画，直到下一次操作重新触发 scheduleContentRedraw()——
      // 真实复现：命令响应内容到达后紧接着进入下一轮 readLiveLine（这里），
      // 用户会看到"没反应"，要按键才突然吐字（见 PROGRESS.md 2026-07-21）。
      // 取消前先同步补画一次，保证已经进了 transcript 的内容不会被静默丢弃。
      const hadPendingRedraw = this.hasPendingContentRedraw();
      this.cancelContentRedraw();
      if (hadPendingRedraw) {
        this.paintContentViewport();
        this.repaintStatus();
      }
      this.openLine = '';
    }
  }

  get isIngestSuspended(): boolean {
    return this.ingestSuspended;
  }

  /** 测试用：当前 transcript 行 */
  debugTranscriptLines(): string[] {
    const transcript = this.openLine ? [...this.transcript, this.openLine] : [...this.transcript];
    return this.welcomeActive ? [...this.welcomeLines, ...transcript] : transcript;
  }

  setMenuOverlay(lines: string[] | null): void {
    this.menuOverlay = lines?.length ? [...lines] : [];
    if (this.isDocked) this.paintContentViewport();
  }

  clearMenuOverlay(): void {
    if (this.menuOverlay.length === 0) return;
    this.menuOverlay = [];
    if (this.isDocked) this.paintContentViewport();
  }

  private beginChrome(): void {
    this.chromeDepth += 1;
    this.paintingChrome = true;
  }

  private endChrome(): void {
    this.chromeDepth = Math.max(0, this.chromeDepth - 1);
    this.paintingChrome = this.chromeDepth > 0;
  }

  /** 直接写物理终端 / 测试 sink；paintingChrome 挡掉 stdout hook 摄入 */
  writePassthrough(s: string): void {
    if (!s) return;
    this.beginChrome();
    try {
      this.writeFn(s);
    } finally {
      this.endChrome();
    }
  }

  repaintStatus(): void {
    if (!this.isDocked) return;
    this.beginChrome();
    try {
      this.paintStatusLine();
    } finally {
      this.endChrome();
    }
  }

  /** 清空整个输入 pane，不碰状态行。留灰底。 */
  clearInputPane(): void {
    if (!this.isDocked) return;
    const top = inputPaneTopRow(this.rows, this.inputPaneHeight);
    const bottom = statusRow(this.rows) - 1;
    for (let r = top; r <= bottom; r++) {
      this.writePassthrough(
        `\x1b[${r};1H\x1b[2K${formatInputPaneLine('', this.cols, { colored: true })}`,
      );
    }
  }

  static shouldUse(opts?: { isTty?: boolean; mode?: 'code' | 'chat' }): boolean {
    // 部分嵌入式终端（如 PyCharm 内置终端）对 process.stdout.isTTY 报告假阴性，
    // 导致误判为非 TTY 而退化到无清屏能力的追加打印路径（状态栏堆积、输入回显错位）。
    // 提供显式开关：LWA_FORCE_ALT_SHELL=1 时跳过 isTTY 检测，直接尝试进入 docked 模式。
    const forced = process.env['LWA_FORCE_ALT_SHELL'] === '1';
    const tty = opts?.isTty ?? (forced || Boolean(process.stdout.isTTY));
    if (!tty) return false;
    if (process.env['CI'] === 'true' || process.env['LWA_PLAIN_SHELL'] === '1') return false;
    return (opts?.mode ?? 'code') === 'code';
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.rows = positiveOr(process.stdout.rows, this.rows);
    this.cols = positiveOr(process.stdout.columns, this.cols);
    this.bannerPrinted = false;
    if (!this.docked) return;

    this.installStdoutHook();
    // writeFn 在 hook 后走 originalStdoutWrite，不会回灌 transcript
    this.writePassthrough('\x1b[?1049h');
    this.writePassthrough('\x1b[2J');
    this.writePassthrough('\x1b[r'); // 不用 DECSTBM：滚出即丢是历史消失的主因
    this.transcript = [];
    this.openLine = '';
    this.streamBlockStart = -1;
    this.scrollOffset = 0;
    this.hasNewContentWhileScrolled = false;
    this.menuOverlay = [];
    this.welcomeLines = [];
    this.welcomeActive = false;
    this.applyLayout();
    this.resizeHandler = () => {
      this.rows = positiveOr(process.stdout.rows, this.rows);
      this.cols = positiveOr(process.stdout.columns, this.cols);
      this.applyLayout();
      this.renderFooter(this.lastFooter);
      this.focusInput();
    };
    process.stdout.on('resize', this.resizeHandler);
  }

  exit(): void {
    if (!this.active) return;
    if (this.chromeRepaintTimer) {
      clearTimeout(this.chromeRepaintTimer);
      this.chromeRepaintTimer = null;
    }
    if (this.contentRedrawTimer) {
      clearTimeout(this.contentRedrawTimer);
      this.contentRedrawTimer = null;
      this.paintContentViewport();
    }
    if (this.resizeHandler) {
      process.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = undefined;
    }
    if (this.docked) {
      this.writePassthrough('\x1b[r');
      this.writePassthrough('\x1b[?1049l');
    }
    this.removeStdoutHook();
    this.active = false;
  }

  focusContent(): void {
    // 内容走 transcript 重绘，无需把物理光标钉在内容底
  }

  focusInput(): void {
    if (!this.isDocked) return;
    this.cancelChromeRepaint();
    this.clearInputPane();
  }

  afterInput(): void {
    if (!this.isDocked) return;
    this.cancelChromeRepaint();
    this.clearInputPane();
    this.repaintStatus();
  }

  write(s: string): void {
    if (!s) return;
    if (this.ingestSuspended) return;
    if (this.isDocked && !this.paintingChrome) {
      this.ingestContent(s);
      this.scheduleContentRedraw();
      return;
    }
    this.writeFn(s);
  }

  appendLine(line: string): void {
    if (!line) return;
    this.write(`${line}\n`);
  }

  appendBlock(text: string): void {
    const body = text.replace(/\r\n/g, '\n');
    if (!body) return;
    if (this.isDocked) {
      this.flushOpenLine();
      this.streamBlockStart = this.transcript.length;
    }
    this.write(body.endsWith('\n') ? body : `${body}\n`);
  }

  /** 用新文本替换最近一次 appendBlock / stream 写入（streaming patch） */
  replaceLastBlock(text: string): void {
    const body = text.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
    if (!this.isDocked) {
      this.appendBlock(body);
      return;
    }
    const start = this.streamBlockStart >= 0 ? this.streamBlockStart : this.transcript.length;
    this.transcript = this.transcript.slice(0, start);
    this.openLine = '';
    this.streamBlockStart = start;
    if (body) this.ingestContent(`${body}\n`);
    this.paintContentViewport();
    this.repaintStatus();
  }

  private flushOpenLine(): void {
    if (this.openLine) {
      this.transcript.push(this.openLine);
      this.openLine = '';
    }
  }

  /** 菜单清空后恢复对话区 */
  redrawContent(): void {
    if (!this.isDocked) return;
    this.paintContentViewport();
    this.repaintStatus();
  }

  /** 当前是否正在翻看历史（非贴底跟随最新）。 */
  get isScrolled(): boolean {
    return this.scrollOffset > 0;
  }

  /** 翻看历史期间是否有新内容到达但未显示（供状态栏提示）。 */
  get hasUnseenContent(): boolean {
    return this.hasNewContentWhileScrolled;
  }

  /** 每页滚动的行数：内容区可视高度（减 1 留一行重叠，避免跳页丢行）。 */
  private pageSize(): number {
    const bottom = contentBottomRow(this.rows, this.inputPaneHeight);
    return Math.max(1, bottom - 1);
  }

  private totalContentLines(): number {
    const conversationLines = this.openLine
      ? [...this.transcript, this.openLine]
      : [...this.transcript];
    return (this.welcomeActive ? this.welcomeLines : conversationLines).length;
  }

  private setScrollOffset(next: number): void {
    const bottom = contentBottomRow(this.rows, this.inputPaneHeight);
    const clamped = clampScrollOffset(next, this.totalContentLines(), bottom);
    if (clamped === this.scrollOffset) return;
    this.scrollOffset = clamped;
    if (this.scrollOffset === 0) this.hasNewContentWhileScrolled = false;
    if (this.isDocked) {
      this.paintContentViewport();
      this.repaintStatus();
    }
  }

  /** PageUp：往上翻一页历史。已经在最早一屏时无操作。 */
  scrollUp(): void {
    if (!this.isDocked || this.welcomeActive) return;
    this.setScrollOffset(this.scrollOffset + this.pageSize());
  }

  /** PageDown：往下翻一页；到底部时恢复自动跟随最新。 */
  scrollDown(): void {
    if (!this.isDocked || this.welcomeActive) return;
    this.setScrollOffset(this.scrollOffset - this.pageSize());
  }

  /** 回到最新内容，恢复自动跟随；清掉"有新消息"提示。 */
  scrollToBottom(): void {
    if (!this.isDocked) return;
    this.setScrollOffset(0);
  }

  renderFooter(footer: ShellFooter): void {
    this.lastFooter = footer;
    if (!this.docked) return;
    this.cancelChromeRepaint();
    this.repaintStatus();
  }

  renderBanner(title: string, hint: string): void {
    if (this.bannerPrinted) return;
    this.bannerPrinted = true;
    const banner = formatShellBanner({
      title,
      subtitle: 'Local agent workbench across Kiro, Cursor, and gateways',
      hint: `Type / for commands · ${hint}`,
      cols: this.cols,
    });
    if (this.isDocked) {
      this.welcomeLines = banner.split('\n');
      this.welcomeActive = true;
      this.paintContentViewport();
      return;
    }
    this.beginChrome();
    try {
      this.writeFn(`${banner}\n`);
    } finally {
      this.endChrome();
    }
  }

  private paintStatusLine(): void {
    const row = statusRow(this.rows);
    const scrollHint = this.isScrolled
      ? this.hasNewContentWhileScrolled
        ? '查看历史中 · 有新消息 · PageDown/Esc 回到最新'
        : '查看历史中 · PageDown/Esc 回到最新'
      : undefined;
    const line = formatDockedStatusLine({
      primary: this.lastFooter.primary || 'Auto',
      secondary: scrollHint ?? this.lastFooter.secondary,
      approval: this.lastFooter.approval,
      cols: this.cols,
    });
    this.writePassthrough(`\x1b[${row};1H\x1b[2K${line}`);
  }

  private ingestContent(raw: string): void {
    if (this.welcomeActive) {
      this.welcomeActive = false;
      this.welcomeLines = [];
    }
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i]!;
      if (ch === '\x1b') {
        i += 1;
        if (raw[i] === '[') {
          i += 1;
          while (i < raw.length && !/[a-zA-Z]/.test(raw[i]!)) i += 1;
          if (i < raw.length) i += 1;
        }
        continue;
      }
      if (ch === '\r') {
        this.openLine = '';
        i += 1;
        continue;
      }
      if (ch === '\n') {
        this.transcript.push(this.openLine);
        this.openLine = '';
        i += 1;
        // 正在翻看历史时，新行到达不能打断阅读：把 scrollOffset 同步加 1，
        // 让用户正在看的内容保持在原来的屏幕位置（视觉上不动），只在状态栏
        // 标记"有新消息"，不强制拉回底部（tmux copy-mode / 主流聊天软件的
        // 通用做法）。
        if (this.scrollOffset > 0) {
          this.scrollOffset += 1;
          this.hasNewContentWhileScrolled = true;
        }
        continue;
      }
      this.openLine += ch;
      i += 1;
    }
    if (this.transcript.length > 2000) {
      const dropped = this.transcript.length - 1500;
      this.transcript = this.transcript.slice(-1500);
      // 截断丢弃了最早的 dropped 行；scrollOffset 是相对底部的偏移量，
      // 数组整体前移后要同步减去，否则会指向不存在的位置或视觉跳动。
      if (this.scrollOffset > 0) {
        this.scrollOffset = Math.max(0, this.scrollOffset - dropped);
      }
    }
  }

  private paintContentViewport(): void {
    const bottom = contentBottomRow(this.rows, this.inputPaneHeight);
    const overlay = this.menuOverlay;
    const overlayH = Math.min(overlay.length, Math.max(0, bottom - 1));
    const bodyBottom = bottom - overlayH;
    const bodyHeight = Math.max(0, bodyBottom);
    const conversationLines = this.openLine
      ? [...this.transcript, this.openLine]
      : [...this.transcript];
    const viewport = layoutContentViewport({
      lines: this.welcomeActive ? this.welcomeLines : conversationLines,
      height: bodyHeight,
      mode: this.welcomeActive ? 'welcome' : 'conversation',
      scrollOffset: this.welcomeActive ? 0 : this.scrollOffset,
    });
    this.beginChrome();
    try {
      for (let r = 1; r <= bodyBottom; r++) {
        const text = truncateToCols(viewport[r - 1] ?? '', this.cols);
        this.writePassthrough(`\x1b[${r};1H\x1b[2K${text}`);
      }
      for (let i = 0; i < overlayH; i++) {
        const r = bodyBottom + 1 + i;
        const text = truncateToCols(overlay[overlay.length - overlayH + i] ?? '', this.cols);
        this.writePassthrough(`\x1b[${r};1H\x1b[2K${text}`);
      }
    } finally {
      this.endChrome();
    }
  }

  private scheduleContentRedraw(): void {
    if (!this.isDocked || this.ingestSuspended) return;
    if (this.contentRedrawTimer) clearTimeout(this.contentRedrawTimer);
    this.contentRedrawTimer = setTimeout(() => {
      this.contentRedrawTimer = null;
      this.paintContentViewport();
      this.repaintStatus();
    }, 30);
  }

  private cancelContentRedraw(): void {
    if (this.contentRedrawTimer) {
      clearTimeout(this.contentRedrawTimer);
      this.contentRedrawTimer = null;
    }
  }

  private hasPendingContentRedraw(): boolean {
    return this.contentRedrawTimer !== null;
  }

  private repaintChromePreserveCursor(): void {
    if (!this.isDocked || this.paintingChrome) return;
    this.beginChrome();
    try {
      this.writePassthrough('\x1b7');
      this.paintStatusLine();
      this.writePassthrough('\x1b8');
    } finally {
      this.endChrome();
    }
  }

  private scheduleChromeRepaint(): void {
    if (!this.isDocked || this.repaintSuspended) return;
    if (this.chromeRepaintTimer) clearTimeout(this.chromeRepaintTimer);
    this.chromeRepaintTimer = setTimeout(() => {
      this.chromeRepaintTimer = null;
      this.repaintChromePreserveCursor();
    }, 40);
  }

  private cancelChromeRepaint(): void {
    if (this.chromeRepaintTimer) {
      clearTimeout(this.chromeRepaintTimer);
      this.chromeRepaintTimer = null;
    }
  }

  private applyLayout(): void {
    this.writePassthrough('\x1b[r');
    this.paintContentViewport();
    this.clearInputPane();
    this.writePassthrough(`\x1b[${statusRow(this.rows)};1H\x1b[2K`);
  }

  private installStdoutHook(): void {
    if (this.originalStdoutWrite) return;
    this.originalStdoutWrite = process.stdout.write.bind(process.stdout);

    process.stdout.write = ((
      chunk: Uint8Array | string,
      encoding?: BufferEncoding,
      cb?: (err?: Error | null) => void,
    ) => {
      if (!this.active || !this.docked || this.paintingChrome) {
        return this.originalStdoutWrite!(chunk as never, encoding as never, cb as never);
      }
      // 输入期：丢掉误写进 stdout 的 prompt/echo，绝不叠进 transcript
      if (this.ingestSuspended) {
        if (typeof cb === 'function') cb(null);
        return true;
      }
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8');
      this.ingestContent(text);
      this.scheduleContentRedraw();
      if (typeof cb === 'function') cb(null);
      return true;
    }) as StdoutWrite;
  }

  private removeStdoutHook(): void {
    if (!this.originalStdoutWrite) return;
    process.stdout.write = this.originalStdoutWrite;
    this.originalStdoutWrite = null;
  }
}

let activeShell: ShellScreen | null = null;

export function setActiveShell(screen: ShellScreen | null): void {
  activeShell = screen;
}

export function getActiveShell(): ShellScreen | null {
  return activeShell;
}

export function cliWrite(s: string): void {
  if (!s) return;
  if (activeShell?.isDocked) {
    activeShell.write(s);
    return;
  }
  process.stdout.write(s);
}
