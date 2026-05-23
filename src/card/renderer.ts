/**
 * 流式卡片渲染器
 *
 * 一次任务一个 CardRenderer。生命周期：
 *   open() → 发出"⏳ 正在思考..."的初始卡片，记下 messageId
 *   appendText(chunk) → 累积文本，节流后 patchCard 更新（streaming 状态）
 *   finalize(state) → 切到终态（done/aborted/timedout/error），刷新一次
 *
 * 节流策略：
 *   - 收到 chunk 不立刻更新；触发 debounce 计时，
 *     在 cardUpdateIntervalMs 内合并所有 chunk 一次 patch
 *   - finalize 时立即 flush，再单独发一次终态 patch
 */
import type { Logger } from 'pino';
import type { LarkClient } from '../lark/client.js';
import { Debouncer } from '../lib/debounce.js';
import { buildCard, truncateForCard, type CardContext, type CardState } from './schema.js';

export interface CardRendererOptions {
  lark: LarkClient;
  chatId: string;
  /** 用于把卡片作为对原消息的 reply（更友好，挂在用户消息下面） */
  replyToMessageId?: string;
  /** 卡片更新的最小间隔（毫秒） */
  intervalMs: number;
  logger: Logger;
  ctx: CardContext;
}

export class CardRenderer {
  private readonly lark: LarkClient;
  private readonly chatId: string;
  private readonly replyToMessageId?: string;
  private readonly debouncer: Debouncer;
  private readonly log: Logger;
  private ctx: CardContext;

  private messageId: string | null = null;
  private accText = '';
  private currentState: CardState = 'pending';
  private closed = false;

  constructor(opts: CardRendererOptions) {
    this.lark = opts.lark;
    this.chatId = opts.chatId;
    if (opts.replyToMessageId !== undefined) {
      this.replyToMessageId = opts.replyToMessageId;
    }
    this.debouncer = new Debouncer(opts.intervalMs);
    this.log = opts.logger.child({ module: 'card-renderer' });
    this.ctx = opts.ctx;
  }

  /** 发出初始卡片。必须在 appendText 之前调用一次。 */
  async open(initialState: CardState = 'pending', initialText = ''): Promise<void> {
    this.currentState = initialState;
    this.accText = initialText;
    const card = buildCard(initialState, truncateForCard(this.accText), this.ctx, true);
    if (this.replyToMessageId) {
      this.messageId = await this.lark.replyCard(this.replyToMessageId, card);
    } else {
      this.messageId = await this.lark.sendCard(this.chatId, card);
    }
    this.log.debug({ messageId: this.messageId, state: initialState }, 'card opened');
  }

  /** 流式追加文本，触发节流更新。 */
  appendText(chunk: string): void {
    if (this.closed) return;
    this.accText += chunk;
    if (this.currentState === 'pending') {
      this.currentState = 'streaming';
    }
    this.debouncer.schedule(async () => {
      await this.flush();
    });
  }

  /** 把累积的文本立即 patch 到飞书。 */
  private async flush(): Promise<void> {
    if (!this.messageId || this.closed) return;
    const card = buildCard(
      this.currentState,
      truncateForCard(this.accText),
      this.ctx,
      this.currentState === 'pending' || this.currentState === 'streaming',
    );
    try {
      await this.lark.patchCard(this.messageId, card);
    } catch (e) {
      this.log.warn({ err: e }, 'patchCard failed; will retry on next chunk');
    }
  }

  /**
   * 切到终态并最后更新一次。
   * @param state 终态：done/aborted/timedout/error
   * @param finalText 如果传入，覆盖现有累积文本（比如错误信息）
   */
  async finalize(state: CardState, finalText?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // 把 debouncer 里残留的 schedule 取消，由我们直接发终态
    this.debouncer.cancel();
    if (finalText !== undefined) this.accText = finalText;
    this.currentState = state;
    if (!this.messageId) {
      // 罕见情况：open 都没成功，直接 sendText 兜底
      try {
        await this.lark.sendText(this.chatId, this.accText.slice(0, 4000));
      } catch (e) {
        this.log.error({ err: e }, 'fallback sendText failed');
      }
      return;
    }
    const card = buildCard(state, truncateForCard(this.accText), this.ctx, false);
    try {
      await this.lark.patchCard(this.messageId, card);
    } catch (e) {
      this.log.error({ err: e }, 'finalize patchCard failed');
    }
  }

  /** 中途切换上下文（比如 /cd 之后 cwd 变了） */
  updateContext(ctx: Partial<CardContext>): void {
    this.ctx = { ...this.ctx, ...ctx };
  }
}
