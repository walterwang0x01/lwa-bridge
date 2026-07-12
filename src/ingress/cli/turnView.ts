/**
 * 本地 coding TUI（最小版）：状态头 + 思考/工具折叠行 + 流式正文。
 * 不引入 ink/blessed；用 ANSI + 行式输出，兼容现有 readline REPL。
 */
import type { UnifiedSessionEvent } from '../../runtime/types.js';
import { shortenHomePath } from './workspace.js';

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

export interface CliTurnViewOptions {
  profileName: string;
  model?: string;
  cwd: string;
  /** 非 TTY 时退化为纯文本（测试 / pipe） */
  isTty?: boolean;
  write?: (s: string) => void;
}

export interface CliTurnViewSummary {
  toolCount: number;
  messageChars: number;
  durationMs: number;
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function toolLabel(name: string, raw: Record<string, unknown>): string {
  const title =
    (typeof raw.title === 'string' && raw.title) ||
    (typeof raw.toolName === 'string' && raw.toolName) ||
    name;
  const input = raw.rawInput ?? raw.input ?? raw.arguments;
  let detail = '';
  if (typeof input === 'string') detail = input;
  else if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    detail = String(obj.command ?? obj.path ?? obj.file_path ?? obj.query ?? obj.pattern ?? '');
  }
  const base = truncate(title, 40);
  return detail ? `${base}  ${GRAY}${truncate(detail, 60)}${RESET}` : base;
}

function statusIcon(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('error') || s.includes('fail')) return `${YELLOW}✗${RESET}`;
  if (s.includes('complet') || s === 'done' || s === 'success') return `${GREEN}✓${RESET}`;
  if (s.includes('run') || s.includes('progress') || s === 'pending') return `${CYAN}●${RESET}`;
  return `${DIM}·${RESET}`;
}

/**
 * 一轮 agent turn 的终端视图。
 */
export class CliTurnView {
  private readonly write: (s: string) => void;
  private readonly isTty: boolean;
  private readonly startedAt = Date.now();
  private readonly tools = new Map<
    string,
    { name: string; status: string; lineWritten: boolean }
  >();
  private thinkingOpen = false;
  private messageStarted = false;
  private messageChars = 0;
  private closed = false;

  constructor(private readonly opts: CliTurnViewOptions) {
    this.write = opts.write ?? ((s) => process.stdout.write(s));
    this.isTty = opts.isTty ?? Boolean(process.stdout.isTTY);
  }

  /** 回合开始：画头 */
  start(): void {
    const model = this.opts.model ? ` · ${this.opts.model}` : '';
    const cwd = shortenHomePath(this.opts.cwd);
    const bar = this.isTty
      ? `${DIM}────────────────────────────────────────${RESET}`
      : '----------------------------------------';
    this.write(`\n${bar}\n`);
    this.write(
      `${BOLD}${CYAN}▶${RESET} ${BOLD}${this.opts.profileName}${RESET}${DIM}${model}${RESET}  ${GRAY}${cwd}${RESET}\n`,
    );
    this.write(`${DIM}… thinking${RESET}\n`);
    this.thinkingOpen = true;
  }

  /** 消费统一事件 */
  onEvent(ev: UnifiedSessionEvent): void {
    if (this.closed) return;

    if (ev.kind === 'thought' && ev.text) {
      if (!this.messageStarted) {
        // 思考只更新同一行提示，避免刷屏
        if (this.thinkingOpen && this.isTty) {
          this.write(`\r${DIM}… thinking${RESET}${DIM}  ${truncate(ev.text, 50)}${RESET}\x1b[K`);
        }
      }
      return;
    }

    if (ev.kind === 'tool') {
      this.clearThinkingLine();
      const prev = this.tools.get(ev.toolCallId);
      const label = toolLabel(ev.name, ev.raw ?? {});
      const icon = statusIcon(ev.status);
      if (!prev?.lineWritten) {
        this.write(`  ${icon} ${label}\n`);
        this.tools.set(ev.toolCallId, {
          name: ev.name,
          status: ev.status,
          lineWritten: true,
        });
      } else if (prev.status !== ev.status) {
        // 完成态补一行短状态（不重画整表，避免和流式正文打架）
        if (/complet|done|success|error|fail/i.test(ev.status)) {
          this.write(
            `  ${icon} ${DIM}${truncate(ev.name, 40)}${RESET} ${GRAY}${ev.status}${RESET}\n`,
          );
        }
        this.tools.set(ev.toolCallId, { ...prev, status: ev.status });
      }
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
    const tools = this.tools.size;
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
    if (this.isTty) {
      this.write(`\r\x1b[K`);
    }
  }
}

/** 纯函数：把 tool raw 压成一行标签（单测用）。 */
export function formatToolLineForTest(
  name: string,
  status: string,
  raw: Record<string, unknown> = {},
): string {
  return `${statusIcon(status)} ${toolLabel(name, raw)}`;
}
