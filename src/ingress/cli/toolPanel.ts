/**
 * 工具调用折叠面板：运行中一行摘要，结束后一行汇总。
 */
import type { UnifiedSessionEvent } from '../../runtime/types.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const GRAY = '\x1b[90m';

export interface ToolPanelEntry {
  id: string;
  name: string;
  status: string;
  label: string;
}

function truncate(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

export function toolDetailLabel(name: string, raw: Record<string, unknown> = {}): string {
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
  const base = truncate(title, 36);
  return detail ? `${base} ${truncate(detail, 48)}` : base;
}

function statusIcon(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('error') || s.includes('fail')) return `${YELLOW}✗${RESET}`;
  if (s.includes('complet') || s === 'done' || s === 'success') return `${GREEN}✓${RESET}`;
  if (s.includes('run') || s.includes('progress') || s === 'pending') return `${CYAN}●${RESET}`;
  return `${DIM}·${RESET}`;
}

function isTerminalStatus(status: string): boolean {
  return /complet|done|success|error|fail/i.test(status);
}

/** 运行中摘要行 */
export function formatToolRunningLine(entries: ToolPanelEntry[]): string {
  const running = entries.filter((e) => !isTerminalStatus(e.status));
  const done = entries.length - running.length;
  if (entries.length === 0) return '';
  const names = (running.length > 0 ? running : entries)
    .slice(0, 3)
    .map((e) => truncate(e.name, 20))
    .join(`${GRAY} · ${RESET}`);
  const extra = entries.length > 3 ? ` ${GRAY}+${entries.length - 3}${RESET}` : '';
  if (running.length > 0) {
    return `  ${CYAN}●${RESET} ${DIM}tools${RESET} (${running.length} running${done ? `, ${done} done` : ''}): ${names}${extra}`;
  }
  return `  ${DIM}tools${RESET} (${done} done): ${names}${extra}`;
}

/** 结束汇总行 */
export function formatToolSummaryLine(entries: ToolPanelEntry[]): string {
  if (entries.length === 0) return '';
  const parts = entries.slice(0, 6).map((e) => {
    const icon = statusIcon(e.status);
    return `${icon} ${truncate(e.name, 16)}`;
  });
  const extra = entries.length > 6 ? ` ${GRAY}+${entries.length - 6}${RESET}` : '';
  return `  ${DIM}▸${RESET} ${entries.length} tool${entries.length === 1 ? '' : 's'}: ${parts.join(`${GRAY} · ${RESET}`)}${extra}`;
}

/**
 * 一轮 turn 内的工具面板（TTY 下折叠，非 TTY 逐行展开）。
 */
export class ToolPanel {
  private readonly entries = new Map<string, ToolPanelEntry>();
  private runningLineWritten = false;
  private expanded = false;
  private readonly compact: boolean;
  private readonly write: (s: string) => void;

  constructor(opts: { compact?: boolean; write?: (s: string) => void }) {
    this.compact = opts.compact ?? true;
    this.write = opts.write ?? ((s) => process.stdout.write(s));
  }

  onEvent(ev: UnifiedSessionEvent): boolean {
    if (ev.kind !== 'tool') return false;
    const label = toolDetailLabel(ev.name, ev.raw ?? {});
    this.entries.set(ev.toolCallId, {
      id: ev.toolCallId,
      name: ev.name,
      status: ev.status,
      label,
    });

    if (!this.compact) {
      this.write(`  ${statusIcon(ev.status)} ${label}\n`);
      return true;
    }

    if (!isTerminalStatus(ev.status) && !this.expanded) {
      this.redrawRunningLine();
      return true;
    }

    if (isTerminalStatus(ev.status) && !this.expanded) {
      this.redrawRunningLine();
      return true;
    }

    this.write(`  ${statusIcon(ev.status)} ${label}\n`);
    return true;
  }

  /** turn 结束：折叠为单行摘要 */
  finish(): string {
    const list = [...this.entries.values()];
    if (list.length === 0) return '';
    if (!this.compact) return '';
    if (this.runningLineWritten) {
      this.write('\r\x1b[K');
      this.runningLineWritten = false;
    }
    const line = formatToolSummaryLine(list);
    this.write(`${line}\n`);
    return line;
  }

  get count(): number {
    return this.entries.size;
  }

  private redrawRunningLine(): void {
    const line = formatToolRunningLine([...this.entries.values()]);
    if (!line) return;
    if (this.runningLineWritten) {
      this.write(`\r\x1b[K${line}`);
    } else {
      this.write(`${line}\n`);
      this.runningLineWritten = true;
    }
  }
}
