/**
 * RunCardController — 一次 Kiro 任务的完整卡片生命周期
 *
 * 替代旧版 CardRenderer。差别：
 *   旧版：维护一个累积字符串（accText + traces 数组），渲染时拼成 markdown
 *   新版：维护一个结构化 RunState 对象，渲染时按状态机派发到不同 element
 *
 * 生命周期：
 *   open() → 发"⏳ 思考中"卡片，记 messageId
 *   applyEvent(ev) → 消费 ACP SessionEvent，结构化更新 RunState；
 *                    节流后 patchCard 重新渲染整个 RunState
 *   markInterrupted() / markIdleTimeout() / markError() → 设置终态
 *   finalize(terminal) → 立即取消节流，发最终态卡片
 */
import type { Logger } from 'pino';
import type { LarkClient } from '../lark/client.js';
import { Debouncer } from '../lib/debounce.js';
import { renderRunCard } from './runRenderer.js';
import {
  appendText,
  createInitialState,
  pushTool,
  type RunState,
  type TerminalState,
  type ToolEntry,
} from '../kiro/runState.js';
import type { SessionEvent } from '../kiro/acp/messages.js';

export interface RunCardControllerOptions {
  lark: LarkClient;
  chatId: string;
  /** 让卡片作为对原消息的 reply（挂在用户消息下面，体验好） */
  replyToMessageId?: string;
  /** 卡片更新的最小间隔（毫秒），节流用 */
  intervalMs: number;
  logger: Logger;
  /** Idle watchdog 阈值（分钟），用于超时态文案 */
  idleTimeoutMinutes?: number;
}

export class RunCardController {
  private readonly lark: LarkClient;
  private readonly chatId: string;
  private readonly replyToMessageId?: string;
  private readonly debouncer: Debouncer;
  private readonly log: Logger;
  /** toolCallId → ToolEntry，用于 tool_call_update 按 id 更新状态 */
  private readonly tools = new Map<string, ToolEntry>();

  private messageId: string | null = null;
  private state: RunState;
  private closed = false;

  constructor(opts: RunCardControllerOptions) {
    this.lark = opts.lark;
    this.chatId = opts.chatId;
    if (opts.replyToMessageId !== undefined) {
      this.replyToMessageId = opts.replyToMessageId;
    }
    this.debouncer = new Debouncer(opts.intervalMs);
    this.log = opts.logger.child({ module: 'run-card' });
    this.state = createInitialState(opts.idleTimeoutMinutes);
  }

  /** 发送初始卡片。必须在 feed 之前调用一次。 */
  async open(): Promise<void> {
    const card = renderRunCard(this.state);
    if (this.replyToMessageId) {
      this.messageId = await this.lark.replyCard(this.replyToMessageId, card);
    } else {
      this.messageId = await this.lark.sendCard(this.chatId, card);
    }
    this.log.debug({ messageId: this.messageId }, 'run card opened');
  }

  /** open() 完成后供外部读取 messageId（用于持久化注册到 ActiveCardsStore）。 */
  getMessageId(): string | null {
    return this.messageId;
  }

  /**
   * 注入/更新任务计划。PlanSource 监听文件变化时调用这里。
   * 调用后立刻安排一次 flush，让用户尽快看到计划更新。
   */
  setPlan(plan: import('../plan/types.js').Plan): void {
    if (this.closed) return;
    this.state.plan = plan;
    this.scheduleFlush();
  }

  /**
   * 消费一个结构化 SessionEvent，更新 RunState，节流后 patchCard。
   *
   * 派发：
   *   - message       → 追加正文文本
   *   - thought       → 写入 reasoning
   *   - tool          → 首次见到 toolCallId 新建工具块；已存在则按 id 更新状态
   *   - turn_end      → no-op（终态由调用方在 runKiro 返回后 finalize）
   */
  applyEvent(ev: SessionEvent): void {
    if (this.closed) return;
    switch (ev.kind) {
      case 'message':
        appendText(this.state, ev.text);
        break;
      case 'thought':
        this.state.reasoning.content += ev.text;
        this.state.reasoning.active = true;
        break;
      case 'tool':
        this.applyToolEvent(ev);
        break;
      case 'turn_end':
        break;
    }
    this.scheduleFlush();
  }

  /** tool_call / tool_call_update 统一入口：按 toolCallId 建块或更新状态。 */
  private applyToolEvent(ev: Extract<SessionEvent, { kind: 'tool' }>): void {
    const status = mapToolStatus(ev.status);
    const existing = this.tools.get(ev.toolCallId);
    if (existing) {
      existing.status = status;
      if (status !== 'running') existing.finishedAt = Date.now();
      return;
    }
    const raw = ev.raw as Record<string, unknown>;
    const input = (raw['rawInput'] ?? raw['input'] ?? {}) as Record<string, unknown>;
    const tool: ToolEntry = {
      id: ev.toolCallId || `t${Date.now().toString(36)}-${this.tools.size}`,
      name: prettifyToolName(ev.name),
      input,
      status,
      startedAt: Date.now(),
    };
    if (status !== 'running') tool.finishedAt = Date.now();
    this.tools.set(ev.toolCallId, tool);
    pushTool(this.state, tool);
  }

  /**
   * 把卡片状态切到终态并立刻刷新。
   *
   * @param terminal 终态：done/error/interrupted/idle_timeout
   * @param errorMsg 仅在 terminal=error 时使用
   */
  async finalize(terminal: TerminalState, errorMsg?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.debouncer.cancel();
    this.state.terminal = terminal;
    this.state.footer = null;
    if (errorMsg !== undefined) this.state.errorMsg = errorMsg;

    // 排查"未返回内容"用：摘要 RunState，关键看 blocks 数量是否为 0
    this.log.debug(
      {
        terminal,
        blocksCount: this.state.blocks.length,
        textBlocks: this.state.blocks.filter((b) => b.kind === 'text').length,
        toolBlocks: this.state.blocks.filter((b) => b.kind === 'tool').length,
        firstTextHead:
          this.state.blocks.find((b) => b.kind === 'text')?.kind === 'text'
            ? (
                this.state.blocks.find((b) => b.kind === 'text') as { content: string }
              ).content.slice(0, 80)
            : undefined,
        reasoningLen: this.state.reasoning.content.length,
        errorMsg: this.state.errorMsg,
      },
      'finalize state snapshot',
    );

    if (!this.messageId) {
      // open 都没成功：兜底 sendText
      try {
        const text = this.fallbackText();
        await this.lark.sendText(this.chatId, text.slice(0, 4000));
      } catch (e) {
        this.log.error({ err: e }, 'fallback sendText failed');
      }
      return;
    }
    const card = renderRunCard(this.state);
    try {
      await this.lark.patchCard(this.messageId, card);
    } catch (e) {
      this.log.error({ err: e }, 'finalize patchCard failed');
    }
  }

  /** 当前是否还在跑（外部判断要不要 flush） */
  isClosed(): boolean {
    return this.closed;
  }

  /** 是否已经产出过可见内容（文本/工具块）。用于判断空任务能否静默丢弃。 */
  hasContent(): boolean {
    return this.state.blocks.length > 0;
  }

  /**
   * 丢弃这张卡片：撤回已发出的占位消息，不留任何终态。
   * 用于"被抢占且零输出"的任务——显示"已中止"纯属噪音。
   * 撤回失败则降级为 finalize('interrupted')，至少给个明确终态。
   */
  async discard(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.debouncer.cancel();
    if (!this.messageId) return;
    try {
      await this.lark.recallMessage(this.messageId);
      this.log.debug({ messageId: this.messageId }, 'empty task card discarded');
    } catch (e) {
      this.log.warn({ err: e }, 'discard failed; leaving card as-is');
    }
  }

  // ----- 内部 -----

  private scheduleFlush(): void {
    this.debouncer.schedule(async () => {
      await this.flush();
    });
  }

  private async flush(): Promise<void> {
    if (!this.messageId || this.closed) return;
    const card = renderRunCard(this.state);
    try {
      await this.lark.patchCard(this.messageId, card);
    } catch (e) {
      this.log.warn({ err: e }, 'patchCard failed; will retry next chunk');
    }
  }

  /** finalize 但 messageId 没发出来时的兜底纯文本 */
  private fallbackText(): string {
    const parts: string[] = [];
    for (const b of this.state.blocks) {
      if (b.kind === 'text') parts.push(b.content);
    }
    if (this.state.errorMsg) parts.push(`\n[错误] ${this.state.errorMsg}`);
    return parts.join('') || '（无回复）';
  }
}

/** ACP 工具状态 → RunState 工具状态。 */
function mapToolStatus(status: string): ToolEntry['status'] {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'error';
  return 'running'; // pending / in_progress / 未知
}

/** 把 ACP 工具名（fs_read / execute_bash 等）规范化成易读名（Read / Bash 等）。 */
function prettifyToolName(name: string): string {
  switch (name) {
    case 'fs_read':
    case 'read':
      return 'Read';
    case 'fs_write':
    case 'write':
      return 'Write';
    case 'execute_bash':
    case 'shell':
    case 'bash':
      return 'Bash';
    case 'grep':
      return 'Grep';
    case 'glob':
      return 'Glob';
    case 'web_search':
      return 'WebSearch';
    case 'web_fetch':
      return 'WebFetch';
    case 'use_aws':
      return 'AWS';
    case 'code':
      return 'Code';
    default:
      return name
        .split('_')
        .map((s) => (s ? s[0]!.toUpperCase() + s.slice(1) : ''))
        .join('');
  }
}
