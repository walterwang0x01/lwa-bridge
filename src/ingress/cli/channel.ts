/**
 * 本地终端入口：纯文本 REPL，不依赖飞书卡片交互。
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { CLI_NAME } from '../../lib/branding.js';
import { cardToPlainText, cleanCliText, formatCliHelp } from './textPresenter.js';
import { formatCliStatusLine } from './workspace.js';
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
  getProfile?: () => Promise<{ profileName: string; model?: string } | undefined>;
  /** code = coding agent；chat = IM 演练 */
  mode?: 'code' | 'chat';
  /** 当前会话 id（可被 /resume 切换） */
  getConversationId?: () => string;
  setConversationId?: (id: string) => void;
}

interface CliStoredMessage {
  conversationId: string;
  text: string;
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

  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
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

  async startInbound(handlers: IngressInboundHandlers): Promise<void> {
    this.handlers = handlers;
    this.connected = true;
    handlers.onReady?.();
  }

  close(): void {
    this.connected = false;
    this.handlers = null;
    this.rl.close();
  }

  async promptLoop(
    conversationId = 'cli-code',
    senderPrincipalId = 'cli-user',
    ctx?: CliPromptContext,
  ): Promise<void> {
    if (!this.handlers) throw new Error('cli ingress not started');

    const activeId = () => ctx?.getConversationId?.() ?? conversationId;

    const resolveLine = async (): Promise<string> => {
      const cwd = ctx ? await ctx.getCwd() : process.cwd();
      const profile = ctx?.getProfile ? await ctx.getProfile() : undefined;
      return formatCliStatusLine({
        cwd,
        profileName: profile?.profileName,
        model: profile?.model,
      });
    };

    const mode = ctx?.mode ?? 'code';
    console.log(
      mode === 'chat'
        ? `${CLI_NAME} chat · local IM rehearsal (no Feishu WS)`
        : `${CLI_NAME} code · local coding agent`,
    );
    console.log(await resolveLine());
    console.log(
      mode === 'chat'
        ? 'Rehearse Feishu-style replies.  /help  ·  /new  ·  .exit\n'
        : 'Ask for a code change in this repo.  /help  ·  /sessions  ·  /new  ·  .exit\n',
    );

    while (this.connected) {
      console.log(`\n${await resolveLine()}`);
      const text = (await this.rl.question('→ ')).trim();
      if (!text) continue;
      if (text === '.exit' || text === '.quit') break;
      if (text === '.help') {
        console.log(formatCliHelp(mode));
        continue;
      }
      const cid = activeId();
      const msg = this.makeTextMessage(cid, senderPrincipalId, text);
      this.messages.set(msg.messageId, { conversationId: cid, text });
      await this.handlers.onMessage(msg);
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

  private printReply(reply: NormalizedReply): void {
    if (reply.kind === 'text') {
      this.resetStream();
      const body = cleanCliText(reply.text);
      if (body) console.log(`\n${body}\n`);
      return;
    }
    const text = cardToPlainText(reply.card);
    if (reply.kind === 'patch_card') {
      this.printStreamingAssistant(text, reply.messageId);
      return;
    }
    if (reply.kind === 'reply_card' || reply.kind === 'card') {
      if (text) console.log(`\n${text}\n`);
      return;
    }
    this.resetStream();
    if (text) console.log(`\n${text}\n`);
  }

  private resetStream(): void {
    this.streamMessageId = undefined;
    this.streamLineCount = 0;
  }

  private printStreamingAssistant(text: string, messageId: string): void {
    const body = text ? `\n${text}\n` : '';
    if (!body) return;
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
