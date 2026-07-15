/**
 * 工具调用折叠面板：运行中一行摘要，结束后一行汇总。
 */
import type { UnifiedSessionEvent } from '../../runtime/types.js';
import { muted, paint, T, turnRail } from './theme.js';

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
    (typeof raw.title === 'string' && raw.title.trim()) ||
    (typeof raw.toolName === 'string' && raw.toolName.trim()) ||
    (typeof raw.kind === 'string' && raw.kind.trim()) ||
    name.trim() ||
    'tool';
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

function entryTitle(e: ToolPanelEntry): string {
  const fromLabel = e.label.replace(/\s+/g, ' ').trim().split(' ')[0] ?? '';
  const name = (e.name || fromLabel || e.id || 'tool').trim();
  return truncate(name || 'tool', 20);
}

function statusIcon(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('error') || s.includes('fail')) return paint(T.err, '✗');
  if (s.includes('complet') || s === 'done' || s === 'success') return paint(T.ok, '✓');
  if (s.includes('run') || s.includes('progress') || s === 'pending') return paint(T.run, '●');
  return muted('·');
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
    .map((e) => entryTitle(e))
    .join(muted(' · '));
  const extra = entries.length > 3 ? muted(` +${entries.length - 3}`) : '';
  const rail = turnRail();
  if (running.length > 0) {
    return `${rail} ${paint(T.run, '●')} ${muted('tools')} (${running.length} running${done ? `, ${done} done` : ''}): ${names}${extra}`;
  }
  return `${rail} ${muted('tools')} (${done} done): ${names}${extra}`;
}

/** 结束汇总行 */
export function formatToolSummaryLine(entries: ToolPanelEntry[]): string {
  if (entries.length === 0) return '';
  const parts = entries.slice(0, 6).map((e) => `${statusIcon(e.status)} ${entryTitle(e)}`);
  const extra = entries.length > 6 ? muted(` +${entries.length - 6}`) : '';
  return `${turnRail()} ${muted('▸')} ${entries.length} tool${entries.length === 1 ? '' : 's'}: ${parts.join(muted(' · '))}${extra}`;
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
    const display =
      (typeof ev.raw?.title === 'string' && ev.raw.title.trim()) ||
      (typeof ev.raw?.toolName === 'string' && ev.raw.toolName.trim()) ||
      ev.name.trim() ||
      label.split(/\s+/)[0] ||
      'tool';
    this.entries.set(ev.toolCallId, {
      id: ev.toolCallId,
      name: display,
      status: ev.status,
      label,
    });

    if (!this.compact) {
      this.write(`${turnRail()} ${statusIcon(ev.status)} ${label}\n`);
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

    this.write(`${turnRail()} ${statusIcon(ev.status)} ${label}\n`);
    return true;
  }

  finish(): string {
    const list = [...this.entries.values()];
    if (list.length === 0) return '';
    if (!this.compact) return '';
    if (this.runningLineWritten) {
      // 清 openLine（勿先 \n commit，否则 transcript 会残留旧 running 行）
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
    // 不带 \n：留在 openLine，\r 更新才能原地替换；避免把过期 running 行写入 transcript
    if (this.runningLineWritten) {
      this.write(`\r\x1b[K${line}`);
    } else {
      this.write(line);
      this.runningLineWritten = true;
    }
  }
}
