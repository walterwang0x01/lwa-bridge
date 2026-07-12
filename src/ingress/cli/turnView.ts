/**
 * 本地 coding TUI：状态头 + 工具折叠面板 + 流式正文。
 */
import type { UnifiedSessionEvent } from '../../runtime/types.js';
import { shortenHomePath } from './workspace.js';
import { ToolPanel, toolDetailLabel } from './toolPanel.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

export interface CliTurnViewOptions {
  profileName: string;
  /** Auto 或粘性引擎名 */
  routeMode?: string;
  model?: string;
  cwd: string;
  /** 非 TTY 时退化为纯文本（测试 / pipe） */
  isTty?: boolean;
  /** TTY 下折叠工具行 */
  compactTools?: boolean;
  write?: (s: string) => void;
}

export interface CliTurnViewSummary {
  toolCount: number;
  messageChars: number;
  durationMs: number;
}

/**
 * 一轮 agent turn 的终端视图。
 */
export class CliTurnView {
  private readonly write: (s: string) => void;
  private readonly isTty: boolean;
  private readonly startedAt = Date.now();
  private readonly toolPanel: ToolPanel;
  private thinkingOpen = false;
  private messageStarted = false;
  private messageChars = 0;
  private closed = false;

  constructor(private readonly opts: CliTurnViewOptions) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.isTty = opts.isTty ?? Boolean(process.stdout.isTTY);
    const compact = opts.compactTools ?? this.isTty;
    this.toolPanel = new ToolPanel({ compact, write: this.write });
  }

  /** 回合开始：画头 */
  start(): void {
    const model = this.opts.model ? ` · ${this.opts.model}` : '';
    const cwd = shortenHomePath(this.opts.cwd);
    const route = this.opts.routeMode ?? 'Auto';
    const head =
      route === 'Auto'
        ? `${BOLD}Auto${RESET}${DIM} → ${this.opts.profileName}${RESET}${DIM}${model}${RESET}`
        : `${BOLD}${route}${RESET}${DIM}${model}${RESET}`;
    const bar = this.isTty
      ? `${DIM}────────────────────────────────────────${RESET}`
      : '----------------------------------------';
    this.write(`\n${bar}\n`);
    this.write(`${BOLD}${CYAN}▶${RESET} ${head}  ${GRAY}${cwd}${RESET}\n`);
    this.write(`${DIM}… thinking${RESET}\n`);
    this.thinkingOpen = true;
  }

  /** 消费统一事件 */
  onEvent(ev: UnifiedSessionEvent): void {
    if (this.closed) return;

    if (ev.kind === 'thought' && ev.text) {
      if (!this.messageStarted && this.thinkingOpen && this.isTty) {
        const snippet = ev.text.replace(/\s+/g, ' ').trim().slice(0, 50);
        this.write(`\r${DIM}… thinking${RESET}${DIM}  ${snippet}${RESET}\x1b[K`);
      }
      return;
    }

    if (ev.kind === 'tool') {
      this.clearThinkingLine();
      this.toolPanel.onEvent(ev);
      return;
    }

    if (ev.kind === 'message' && ev.text) {
      this.clearThinkingLine();
      if (!this.messageStarted) {
        this.messageStarted = true;
        this.write(`\n`);
      }
      this.messageChars += ev.text.length;
      this.write(ev.text);
    }
  }

  /** 回合结束 */
  end(opts?: {
    aborted?: boolean;
    timedOut?: boolean;
    error?: string;
    textFallback?: string;
  }): CliTurnViewSummary {
    this.clearThinkingLine();
    this.toolPanel.finish();
    if (!this.messageStarted && opts?.textFallback) {
      this.write(`\n${opts.textFallback}`);
      this.messageChars += opts.textFallback.length;
      this.messageStarted = true;
    }
    if (opts?.aborted) this.write(`\n${YELLOW}(aborted)${RESET}\n`);
    else if (opts?.timedOut) this.write(`\n${YELLOW}(timeout)${RESET}\n`);
    else if (opts?.error) this.write(`\n${YELLOW}(error: ${opts.error})${RESET}\n`);
    else this.write('\n');

    const durationMs = Date.now() - this.startedAt;
    const tools = this.toolPanel.count;
    const secs = (durationMs / 1000).toFixed(1);
    this.write(
      `${DIM}────────────────────────────────────────${RESET}\n` +
        `${GRAY}done · ${secs}s` +
        (tools ? ` · ${tools} tool${tools === 1 ? '' : 's'}` : '') +
        `${RESET}\n`,
    );
    this.closed = true;
    return { toolCount: tools, messageChars: this.messageChars, durationMs };
  }

  private clearThinkingLine(): void {
    if (!this.thinkingOpen) return;
    this.thinkingOpen = false;
    if (this.isTty) this.write(`\r\x1b[K`);
  }
}

/** 单测兼容 */
export function formatToolLineForTest(
  name: string,
  status: string,
  raw: Record<string, unknown> = {},
): string {
  const label = toolDetailLabel(name, raw);
  const s = status.toLowerCase();
  const icon =
    s.includes('error') || s.includes('fail')
      ? '✗'
      : s.includes('complet') || s === 'done' || s === 'success'
        ? '✓'
        : '●';
  return `${icon} ${label}`;
}
