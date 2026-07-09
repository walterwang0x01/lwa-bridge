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
import type { IngressPort } from '../ingress/types.js';
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
  ingress: IngressPort;
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
  private readonly ingress: IngressPort;
  private readonly chatId: string;
  private readonly replyToMessageId?: string;
  private readonly debouncer: Debouncer;
  private readonly log: Logger;
  /** toolCallId → ToolEntry，用于 tool_call_update 按 id 更新状态 */
  private readonly tools = new Map<string, ToolEntry>();

  private messageId: string | null = null;
  private state: RunState;
  private closed = false;
  /**
   * patch 串行化链：所有 patchCard（流式 flush + finalize）排到这条链上顺序执行，
   * 避免并发 patch 时「飞行中的 running flush 后到、覆盖 finalize 的 done」竞态。
   */
  private patchChain: Promise<void> = Promise.resolve();

  constructor(opts: RunCardControllerOptions) {
    this.ingress = opts.ingress;
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
      this.messageId = await this.ingress.replyCard(this.replyToMessageId, card);
    } else {
      this.messageId = await this.ingress.sendCard(this.chatId, card);
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
      case 'metadata': {
        // 累积用量/成本（contextPercent 取最新值，credits/耗时取最后一次带的）
        const u = this.state.usage ?? {};
        if (ev.contextUsagePercentage !== undefined) u.contextPercent = ev.contextUsagePercentage;
        if (ev.credits !== undefined) u.credits = ev.credits;
        if (ev.turnDurationMs !== undefined) u.turnDurationMs = ev.turnDurationMs;
        this.state.usage = u;
        break;
      }
      case 'turn_end':
        break;
    }
    this.scheduleFlush();
  }

  /** tool_call / tool_call_update 统一入口：按 toolCallId 建块或更新状态。 */
  private applyToolEvent(ev: Extract<SessionEvent, { kind: 'tool' }>): void {
    const status = mapToolStatus(ev.status);
    const raw = ev.raw as Record<string, unknown>;
    const existing = this.tools.get(ev.toolCallId);

    if (existing) {
      // 更新：合并这次 update 带来的新字段（status / 结果 / 标题等可能分多条到达）。
      existing.status = status;
      if (status !== 'running') existing.finishedAt = Date.now();
      mergeToolFields(existing, raw);
      return;
    }

    const input = (raw['rawInput'] ?? raw['input'] ?? {}) as Record<string, unknown>;
    const tool: ToolEntry = {
      id: ev.toolCallId || `t${Date.now().toString(36)}-${this.tools.size}`,
      name: prettifyToolName(ev.name),
      input,
      status,
      startedAt: Date.now(),
    };
    if (status !== 'running') tool.finishedAt = Date.now();
    mergeToolFields(tool, raw);
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
        await this.ingress.sendText(this.chatId, text.slice(0, 4000));
      } catch (e) {
        this.log.error({ err: e }, 'fallback sendText failed');
      }
      return;
    }
    // 走串行链，排在所有已入队的流式 flush 之后，确保 done 是最后一次实际 patch
    await this.enqueuePatch(true);
  }

  /** 当前是否还在跑（外部判断要不要 flush） */
  isClosed(): boolean {
    return this.closed;
  }

  /** 是否已经产出过可见内容（文本/工具块）。用于判断空任务能否静默丢弃。 */
  hasContent(): boolean {
    return this.state.blocks.length > 0;
  }

  /** 当前终态（finalize 调用后有效）。供 TaskHistoryStore 记录用。 */
  getTerminal(): TerminalState {
    return this.state.terminal;
  }

  /** 错误信息（terminal === 'error' 时有值）。供 TaskHistoryStore 记录用。 */
  getErrorMsg(): string | undefined {
    return this.state.errorMsg;
  }

  /**
   * 任务历史摘要：工具调用总数 + 涉及的文件路径（去重）。
   * 供 executeKiroTask finalize 后写入 TaskHistoryStore。
   * 文件路径从常见写文件工具的 input.path/input.file_path 字段提取，
   * 提取不到不算错误（不是所有工具都操作文件）。
   */
  summarizeForHistory(): { toolCallCount: number; artifacts: string[] } {
    const artifacts = new Set<string>();
    let toolCallCount = 0;
    for (const b of this.state.blocks) {
      if (b.kind !== 'tool') continue;
      toolCallCount++;
      const p = b.tool.input['path'] ?? b.tool.input['file_path'] ?? b.tool.input['targetFile'];
      if (typeof p === 'string' && p) artifacts.add(p);
    }
    return { toolCallCount, artifacts: [...artifacts] };
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
      await this.ingress.recallMessage(this.messageId);
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
    await this.enqueuePatch(false);
  }

  /**
   * 把一次 patchCard 排到串行链上，保证顺序执行（不并发）。
   * @param isFinal finalize 调用时为 true：它是终态写入，链上它之后不应再有 patch 覆盖。
   *   非 final 的 flush 在真正执行前再查一次 closed——若已 finalize 就跳过，
   *   避免延迟的 running flush 覆盖已写入的 done。
   */
  private enqueuePatch(isFinal: boolean): Promise<void> {
    this.patchChain = this.patchChain.then(async () => {
      if (!this.messageId) return;
      // 非终态 patch：轮到自己执行时若已 finalize，跳过（终态优先）
      if (!isFinal && this.closed) return;
      const card = renderRunCard(this.state);
      try {
        await this.ingress.patchCard(this.messageId, card);
      } catch (e) {
        if (isFinal) {
          this.log.error({ err: e }, 'finalize patchCard failed');
        } else {
          this.log.warn({ err: e }, 'patchCard failed; will retry next chunk');
        }
      }
    });
    return this.patchChain;
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

/**
 * 把 ACP 工具事件 raw 里的可用字段合并进 ToolEntry。
 * 这些字段可能分散在 tool_call 和后续的 tool_call_update 里（多条到达），
 * 因此每次都尝试补齐：已有值不被空值覆盖。
 */
function mergeToolFields(tool: ToolEntry, raw: Record<string, unknown>): void {
  // Kiro 自带的人类可读标题（"Running: echo done" / "Reading sample.txt:1"）
  const title = raw['title'];
  if (typeof title === 'string' && title) tool.title = title;

  // 工具类别（read / execute / edit ...），用于选图标
  const kind = raw['kind'];
  if (typeof kind === 'string' && kind) tool.kind = kind;

  // 调用目的（Kiro 在 rawInput.__tool_use_purpose 里给）
  const input = raw['rawInput'];
  if (input && typeof input === 'object') {
    const purpose = (input as Record<string, unknown>)['__tool_use_purpose'];
    if (typeof purpose === 'string' && purpose) tool.purpose = purpose;
  }

  // 工具执行结果：rawOutput.items[] 或 content[]，归一成展示文本
  const out = extractToolOutput(raw);
  if (out) tool.output = out;
}

/**
 * 从 ACP 工具事件提取执行结果文本。
 * 见过的形态：
 *   - rawOutput.items[].Json = { stdout, stderr, exit_status }   （shell）
 *   - rawOutput.items[].Text = "文件内容"                         （读文件）
 *   - content[].content.text = "..."                            （通用文本块）
 * 提取失败返回空字符串。
 */
function extractToolOutput(raw: Record<string, unknown>): string {
  const parts: string[] = [];

  const rawOutput = raw['rawOutput'];
  if (rawOutput && typeof rawOutput === 'object') {
    const items = (rawOutput as Record<string, unknown>)['items'];
    if (Array.isArray(items)) {
      for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        const rec = it as Record<string, unknown>;
        if (typeof rec['Text'] === 'string') {
          parts.push(rec['Text'] as string);
        } else if (rec['Json'] && typeof rec['Json'] === 'object') {
          const j = rec['Json'] as Record<string, unknown>;
          // shell 结果：优先 stdout，附带非空 stderr
          const stdout = typeof j['stdout'] === 'string' ? (j['stdout'] as string) : '';
          const stderr = typeof j['stderr'] === 'string' ? (j['stderr'] as string) : '';
          if (stdout) parts.push(stdout);
          if (stderr.trim()) parts.push(`[stderr] ${stderr}`);
          if (!stdout && !stderr.trim()) parts.push(JSON.stringify(j));
        }
      }
    }
  }

  if (parts.length === 0) {
    const content = raw['content'];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const inner = (block as Record<string, unknown>)['content'];
        if (inner && typeof inner === 'object') {
          const text = (inner as Record<string, unknown>)['text'];
          if (typeof text === 'string') parts.push(text);
        }
      }
    }
  }

  return parts.join('\n').trim();
}
