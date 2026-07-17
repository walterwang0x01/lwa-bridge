/**
 * 本地 coding TUI：LWA Harbor 风格（竖轨 + 品牌色，不模仿 kiro）。
 */
import type { UnifiedSessionEvent } from '../../runtime/types.js';
import { shortenHomePath } from './workspace.js';
import { ToolPanel, toolDetailLabel } from './toolPanel.js';
import {
  formatThinkingLine,
  formatTurnFooter,
  formatTurnHeader,
  muted,
  paint,
  T,
  turnRail,
} from './theme.js';

export interface CliTurnViewOptions {
  profileName: string;
  routeMode?: string;
  model?: string;
  cwd: string;
  isTty?: boolean;
  compactTools?: boolean;
  write?: (s: string) => void;
}

export interface CliTurnViewSummary {
  toolCount: number;
  messageChars: number;
  durationMs: number;
}

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

  start(): void {
    this.write(
      formatTurnHeader({
        routeMode: this.opts.routeMode ?? 'Auto',
        engine: this.opts.profileName,
        model: this.opts.model,
        cwd: shortenHomePath(this.opts.cwd),
      }),
    );
    if (this.isTty) {
      this.write(formatThinkingLine());
      this.thinkingOpen = true;
    } else {
      this.write(`${turnRail()} ${muted('thinking…')}\n`);
    }
  }

  onEvent(ev: UnifiedSessionEvent): void {
    if (this.closed) return;

    if (ev.kind === 'thought' && ev.text) {
      if (!this.messageStarted && this.thinkingOpen && this.isTty) {
        this.write(formatThinkingLine(ev.text.replace(/\s+/g, ' ').trim()));
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
      // 工具调用可能穿插在文字回复的任意位置（不只是第一段消息之前——AI 也
      // 可能"说一段话 → 调工具 → 接着再说"）。ToolPanel 在 compact 模式下用
      // \r 原地刷新 running/done 状态，最后一行不带换行（等 end() 时统一
      // finish() 提交完整摘要）。只要这行还没被收尾，任何后续消息文字到达前
      // 都要先补一次换行，否则会跟它拼在同一行
      // （如 "tools (2 done): tool · tool我是..."）。不用 finish()：那会
      // 连带打印完整摘要，且 finish() 不清空条目列表，end() 时会重复打印。
      const brokeToolLine = this.toolPanel.breakOpenLine();
      if (!this.messageStarted) {
        this.messageStarted = true;
        this.write(`${turnRail()} `);
      } else if (brokeToolLine) {
        // 已经是第二段（及以后）消息：换行让出工具行之后，这一行本身没有
        // 消息轨道前缀，补上，否则视觉上像是接在工具摘要后面的裸文本。
        this.write(`${turnRail()} `);
      }
      this.messageChars += ev.text.length;
      // 多行时给后续行加轨（简单：仅首行加轨，正文原样流式）
      this.write(ev.text);
    }
  }

  end(opts?: {
    aborted?: boolean;
    timedOut?: boolean;
    error?: string;
    textFallback?: string;
  }): CliTurnViewSummary {
    this.clearThinkingLine();
    this.toolPanel.finish();
    if (!this.messageStarted && opts?.textFallback) {
      this.write(`\n${turnRail()} ${opts.textFallback}`);
      this.messageChars += opts.textFallback.length;
      this.messageStarted = true;
    }
    if (opts?.aborted) this.write(`\n${turnRail()} ${paint(T.warn, 'aborted')}\n`);
    else if (opts?.timedOut) this.write(`\n${turnRail()} ${paint(T.warn, 'timeout')}\n`);
    else if (opts?.error) this.write(`\n${turnRail()} ${paint(T.err, opts.error)}\n`);
    else this.write('\n');

    const durationMs = Date.now() - this.startedAt;
    const tools = this.toolPanel.count;
    const secs = (durationMs / 1000).toFixed(1);
    this.write(formatTurnFooter({ secs, toolCount: tools }));
    this.closed = true;
    return { toolCount: tools, messageChars: this.messageChars, durationMs };
  }

  private clearThinkingLine(): void {
    if (!this.thinkingOpen) return;
    this.thinkingOpen = false;
    if (this.isTty) this.write(`\r\x1b[K`);
  }
}

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
