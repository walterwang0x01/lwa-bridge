/**
 * 本地终端入口：纯文本 REPL，不依赖飞书卡片交互。
 * code 模式 + TTY 时启用 ShellScreen（内容滚动 + 固定输入 + 底栏状态）。
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { CLI_NAME } from '../../lib/branding.js';
import { cardToPlainText, cleanCliText, formatCliHelp } from './textPresenter.js';
import { formatCliFooter, type CliStatusSnapshot } from './statusBar.js';
import { setActiveShell, ShellScreen } from './shellScreen.js';
import { formatShellStatusBlock } from './theme.js';
import { pickSlashCommand, setCliInteract } from './slashPicker.js';
import { readLiveLine, suppressInputDuring } from './liveInput.js';
import type {
  IngressChannel,
  IngressInboundHandlers,
  IngressPort,
  NormalizedCardAction,
  NormalizedMessage,
  NormalizedReply,
} from '../types.js';

export interface CliPromptContext {
  getCwd: () => Promise<string> | string;
  /** code = coding agent；chat = IM 演练 */
  mode?: 'code' | 'chat';
  /** 当前会话 id（可被 /resume 切换） */
  getConversationId?: () => string;
  setConversationId?: (id: string) => void;
  /** 底部状态栏快照（Cursor 风格） */
  getStatusSnapshot?: () => Promise<CliStatusSnapshot | undefined>;
}

interface CliStoredMessage {
  conversationId: string;
  text: string;
}

/**
 * 计算非 docked 兜底路径下状态栏内容的去重 key。
 * 抽成纯函数便于独立单测；语义：primary/secondary/approval 三者完全相同才视为“未变化”。
 */
export function plainFooterKey(foot: {
  primary: string;
  secondary: string;
  approval?: string;
}): string {
  return `${foot.primary}\u0000${foot.secondary}\u0000${foot.approval ?? ''}`;
}

/**
 * 单行输入的先进先出队列，配合 readline 的持久 'line' 监听器使用。
 *
 * 背景：readline 的 `question()` 内部用一次性的 `once('line', …)` 监听器接收输入；
 * 若用户在上一条消息处理期间（onMessage 的 await 阶段）敲了 Enter 提交，此时没有
 * 任何 question() 在等待，这个 'line' 事件会在无人监听的情况下触发并永久丢失
 * （这不同于 rl.pause()/process.stdin.pause()，那两者要么不确定丢字符，要么在
 * resume 后立刻同步触发 'line'，同样可能发生在无人监听的窗口里）。
 * 用一个持久监听器把每一行都先交给这个队列：push() 收到行时，若已有消费者在
 * take() 等待就直接唤醒，否则先存入队列；take() 被调用时，队列非空就立刻出队，
 * 否则挂起等待下一次 push()。这样无论用户何时提交，输入都不会丢失。
 */
export class LineQueue {
  private readonly pending: string[] = [];
  private waiter: ((line: string) => void) | null = null;

  push(line: string): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(line);
    } else {
      this.pending.push(line);
    }
  }

  take(): Promise<string> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export class CliIngressChannel implements IngressChannel {
  readonly id = 'cli' as const;
  readonly port: IngressPort;

  private handlers: IngressInboundHandlers | null = null;
  private connected = false;
  private botPrincipalId = 'cli-bot';
  private readonly messages = new Map<string, CliStoredMessage>();
  private readonly rl: Interface;
  private seq = 0;
  private streamMessageId?: string;
  private streamLineCount = 0;
  private shell: ShellScreen | null = null;
  /** 非 docked 兜底路径下缓存的上一次状态栏文本，避免每轮循环无变化也重复追加打印。 */
  private lastPlainFooterKey: string | null = null;
  /** 见 LineQueue 类注释：取代 rl.question() 的一次性监听，避免输入在处理期间丢失。 */
  private readonly lineQueue = new LineQueue();

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on('line', (line) => this.lineQueue.push(line));
    this.port = {
      channel: 'cli',
      getCachedBotPrincipalId: () => this.botPrincipalId,
      setBotPrincipalId: (id) => {
        this.botPrincipalId = id;
      },
      isConnected: () => this.connected,
      getMessageContent: async (messageId) => {
        const msg = this.messages.get(messageId);
        if (!msg) return [];
        return [
          { messageId, msgType: 'text', content: JSON.stringify({ text: msg.text }), mentions: [] },
        ];
      },
      replyCard: async (replyToMessageId, card) => {
        const id = this.nextMessageId('card');
        const reply = this.messages.get(replyToMessageId);
        const conversationId = reply?.conversationId ?? 'cli-local';
        const text = cardToPlainText(card);
        this.messages.set(id, { conversationId, text });
        this.streamMessageId = id;
        this.streamLineCount = 0;
        this.printReply({ kind: 'reply_card', replyToMessageId, card });
        return id;
      },
      sendText: async (conversationId, text) => {
        const id = this.nextMessageId('text');
        this.messages.set(id, { conversationId, text });
        this.printReply({ kind: 'text', conversationId, text });
        return id;
      },
      sendCard: async (conversationId, card) => {
        const id = this.nextMessageId('card');
        const text = cardToPlainText(card);
        this.messages.set(id, { conversationId, text });
        this.streamMessageId = id;
        this.streamLineCount = 0;
        this.printReply({ kind: 'card', conversationId, card });
        return id;
      },
      patchCard: async (messageId, card) => {
        const existing = this.messages.get(messageId);
        const text = cardToPlainText(card);
        this.messages.set(messageId, {
          conversationId: existing?.conversationId ?? 'cli-local',
          text,
        });
        this.printReply({ kind: 'patch_card', messageId, card });
      },
      recallMessage: async (messageId) => {
        this.messages.delete(messageId);
      },
      downloadInboundMedia: async () => [],
      transcribeInboundAudio: async () => ({
        ok: false,
        reason: 'unsupported',
        detail: 'cli ingress has no audio attachments',
      }),
    };
  }

  /**
   * 取代 `this.rl.question(prompt)`：与构造函数里注册的持久 'line' 监听器配合，
   * 保证消息处理期间用户提交的输入不会因为"当时没有 question() 在等待"而丢失。
   * 队列里已有行时直接出队（不需要重新打印 prompt，因为这一行本来就已经在
   * 之前的某个时刻回显在终端上了）；否则打印 prompt 并挂起等待下一行。
   */
  private readLine(prompt: string): Promise<string> {
    const result = this.lineQueue.take();
    process.stdout.write(prompt);
    return result;
  }

  async startInbound(handlers: IngressInboundHandlers): Promise<void> {
    this.handlers = handlers;
    this.connected = true;
    handlers.onReady?.();
  }

  close(): void {
    this.connected = false;
    this.handlers = null;
    setActiveShell(null);
    this.shell?.exit();
    this.shell = null;
    this.rl.close();
  }

  async promptLoop(
    conversationId = 'cli-code',
    senderPrincipalId = 'cli-user',
    ctx?: CliPromptContext,
  ): Promise<void> {
    if (!this.handlers) throw new Error('cli ingress not started');

    const mode = ctx?.mode ?? 'code';
    const useShell = ShellScreen.shouldUse({ mode });
    if (useShell) {
      this.shell = new ShellScreen();
      this.shell.enter();
      setActiveShell(this.shell);
    }

    try {
      await this.runPromptLoop(conversationId, senderPrincipalId, ctx, mode);
    } finally {
      setActiveShell(null);
      this.shell?.exit();
      this.shell = null;
    }
  }

  private async runPromptLoop(
    conversationId: string,
    senderPrincipalId: string,
    ctx: CliPromptContext | undefined,
    mode: 'code' | 'chat',
  ): Promise<void> {
    const activeId = () => ctx?.getConversationId?.() ?? conversationId;

    const resolveFooter = async (): Promise<{
      primary: string;
      secondary: string;
      approval?: string;
    }> => {
      const snapshot = ctx?.getStatusSnapshot ? await ctx.getStatusSnapshot() : undefined;
      if (snapshot) return formatCliFooter(snapshot);
      const cwd = ctx ? await ctx.getCwd() : process.cwd();
      return { primary: String(cwd), secondary: '' };
    };

    const printFooter = async (): Promise<void> => {
      const foot = await resolveFooter();
      if (this.shell?.isDocked) {
        this.shell.renderFooter({
          primary: foot.primary,
          secondary: foot.secondary,
          approval: foot.approval,
        });
        return;
      }
      // 非 docked 兜底路径没有"清空重绘"能力，process.stdout.write 是纯追加打印；
      // 若状态较上一轮未变化就不再重复打印，避免历史状态栏在滚动区无限堆积
      // （PyCharm 等嵌入式终端常因 process.stdout.isTTY 假阴性走到这条路径）。
      const footerKey = plainFooterKey(foot);
      if (footerKey === this.lastPlainFooterKey) return;
      this.lastPlainFooterKey = footerKey;
      if (process.stdout.isTTY) {
        process.stdout.write(formatShellStatusBlock(foot.primary, foot.secondary));
      } else {
        console.log(`\n${foot.primary}`);
        if (foot.secondary) console.log(foot.secondary);
      }
    };

    const title = mode === 'chat' ? 'chat · local IM rehearsal' : 'code · multi-engine shell';
    const hint = mode === 'chat' ? '/help · /new · .exit' : '/ · /runtime · /yolo · /help · .exit';

    if (this.shell?.isActive) {
      this.shell.renderBanner(title, hint);
    } else {
      console.log(`${CLI_NAME} ${title}`);
      console.log(hint);
    }

    setCliInteract({
      ask: async (prompt) => {
        if (this.shell?.isDocked) this.shell.focusInput();
        const ans = await this.readLine(prompt);
        if (this.shell?.isDocked) this.shell.afterInput();
        return ans;
      },
      pauseReadline: () => this.rl.pause(),
      resumeReadline: () => this.rl.resume(),
    });

    try {
      while (this.connected) {
        await printFooter();
        if (this.shell?.isDocked) this.shell.focusInput();
        // docked：敲 `/` 即时出菜单；plain：仍用 readline
        let text = await readLiveLine({
          shell: this.shell,
          mode,
          fallbackAsk: (p) => this.readLine(p),
          pauseReadline: () => this.rl.pause(),
          resumeReadline: () => this.rl.resume(),
        });
        // liveInput.finish 已 afterInput；plain 路径无需
        if (!this.shell?.isDocked && this.shell?.isActive) this.shell.afterInput();
        // 保留末尾空格（/cd ）；只去掉首空白与尾换行
        text = text.replace(/^\s+/, '').replace(/\n+$/g, '');
        const command = text.trim();
        if (!command) continue;
        if (command === '.exit' || command === '.quit') break;
        if (command === '.help') {
          const help = formatCliHelp(mode);
          if (this.shell?.isActive) this.shell.appendBlock(help);
          else console.log(help);
          continue;
        }
        // 兼容：非 live 路径只交 `/` 时仍弹一次菜单
        if (command === '/' && !this.shell?.isDocked) {
          const picked = await pickSlashCommand(mode);
          if (!picked) continue;
          text = picked.trim();
          if (!text) continue;
        }
        const cid = activeId();
        const msg = this.makeTextMessage(cid, senderPrincipalId, text);
        this.messages.set(msg.messageId, { conversationId: cid, text });
        // 非 docked 简化模式没有清屏重绘能力，所有内容在滚动区里纯追加；
        // 提交后先打一行空行分隔，让"用户输入 → 处理中 → 回复"这一轮有清晰起点，
        // 避免处理反馈和上一轮内容、底部状态栏文字混在一起显得毫无响应。
        if (!this.shell?.isDocked) console.log('');
        if (this.shell?.isDocked) {
          // docked 模式：处理期间保持 raw mode 并吞掉按键回显，避免用户在等待
          // 期间的按键被终端默认行为直接写到 thinking 动画所在的屏幕位置，与其
          // 交织产生拼接乱码（见 suppressInputDuring 注释）。raw mode 下 Ctrl+C
          // 不会自动转成 SIGINT（终端默认行为被禁用），手动触发一次以复用
          // bootstrap.ts 里已经注册的正常退出/清理流程。
          await suppressInputDuring(async () => this.handlers!.onMessage(msg), {
            onInterrupt: () => process.kill(process.pid, 'SIGINT'),
          });
        } else {
          await this.handlers!.onMessage(msg);
        }
      }
    } finally {
      setCliInteract(null);
    }
  }

  async emitCardAction(evt: NormalizedCardAction): Promise<void> {
    if (!this.handlers?.onCardAction) throw new Error('cli ingress card handler not set');
    await this.handlers.onCardAction(evt);
  }

  private makeTextMessage(
    conversationId: string,
    senderPrincipalId: string,
    text: string,
  ): NormalizedMessage {
    const now = Date.now();
    return {
      channel: 'cli',
      eventId: this.nextMessageId('evt'),
      messageId: this.nextMessageId('msg'),
      conversationId,
      conversationKind: 'p2p',
      senderPrincipalId,
      messageType: 'text',
      rawContent: JSON.stringify({ text }),
      text,
      mentions: [],
      receivedAt: now,
    };
  }

  private nextMessageId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private emitOutput(text: string): void {
    if (!text) return;
    if (this.shell?.isActive) {
      if (this.shell.isDocked) this.shell.focusContent();
      this.shell.appendBlock(text);
      return;
    }
    console.log(`\n${text}\n`);
  }

  private printReply(reply: NormalizedReply): void {
    if (reply.kind === 'text') {
      this.resetStream();
      this.emitOutput(cleanCliText(reply.text));
      return;
    }
    const text = cardToPlainText(reply.card);
    if (reply.kind === 'patch_card') {
      this.printStreamingAssistant(text, reply.messageId);
      return;
    }
    if (reply.kind === 'reply_card' || reply.kind === 'card') {
      if (text) this.emitOutput(text);
      return;
    }
    this.resetStream();
    if (text) this.emitOutput(text);
  }

  private resetStream(): void {
    this.streamMessageId = undefined;
    this.streamLineCount = 0;
  }

  private printStreamingAssistant(text: string, messageId: string): void {
    const body = text ? `\n${text}\n` : '';
    if (!body) return;
    if (this.shell?.isActive) {
      if (this.shell.isDocked) this.shell.focusContent();
      // docked：同 message 的 patch 替换而非追加，避免全文重复堆叠
      if (this.shell.isDocked && this.streamMessageId === messageId) {
        this.shell.replaceLastBlock(text);
      } else {
        this.streamMessageId = messageId;
        this.shell.appendBlock(text);
      }
      return;
    }
    if (!process.stdout.isTTY) {
      console.log(body);
      return;
    }
    if (this.streamMessageId === messageId && this.streamLineCount > 0) {
      process.stdout.write(`\x1b[${this.streamLineCount}A\x1b[0J`);
    } else {
      this.streamMessageId = messageId;
    }
    process.stdout.write(body);
    this.streamLineCount = body.split('\n').length;
  }
}
