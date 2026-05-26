/**
 * RunCardController — 一次 Kiro 任务的完整卡片生命周期
 *
 * 替代旧版 CardRenderer。差别：
 *   旧版：维护一个累积字符串（accText + traces 数组），渲染时拼成 markdown
 *   新版：维护一个结构化 RunState 对象，渲染时按状态机派发到不同 element
 *
 * 生命周期：
 *   open() → 发"⏳ 思考中"卡片，记 messageId
 *   feed(chunk) → 流式喂 stdout，内部通过 parser 更新 RunState；
 *                 节流后 patchCard 重新渲染整个 RunState
 *   markInterrupted() / markIdleTimeout() / markError() → 设置终态
 *   finalize(terminal) → 立即取消节流，发最终态卡片
 */
import type { Logger } from 'pino';
import type { LarkClient } from '../lark/client.js';
import { Debouncer } from '../lib/debounce.js';
import { renderRunCard } from './runRenderer.js';
import { createInitialState, type RunState, type TerminalState } from '../kiro/runState.js';
import { createRunStreamParser, type RunStreamParser } from '../kiro/runStreamParser.js';

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
  private readonly parser: RunStreamParser;

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
    this.parser = createRunStreamParser();
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
   * 喂入一段 stdout chunk（已 stripAnsi）。
   * 内部经过 parser 更新 state，节流后 patchCard。
   */
  feed(chunk: string): void {
    if (this.closed) return;
    this.parser.feed(chunk, this.state);
    // 高频日志，用 trace 级别（默认看不到）。debug 级别给 runner.ts 的 chunk 已经够用。
    this.log.trace(
      {
        chunkLen: chunk.length,
        blocksCount: this.state.blocks.length,
      },
      'card feed',
    );
    this.scheduleFlush();
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
    // 把 parser 缓冲里残余的最后一行刷出来
    this.parser.flush(this.state);
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
