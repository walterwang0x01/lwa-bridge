import { createInterface, type Interface } from 'node:readline/promises';
import type {
  IngressChannel,
  IngressInboundHandlers,
  IngressPort,
  NormalizedCardAction,
  NormalizedMessage,
  NormalizedMessageItem,
  NormalizedReply,
} from '../types.js';

interface CliStoredMessage {
  conversationId: string;
  text: string;
}

function renderCardToText(card: object): string {
  const texts: string[] = [];
  walkCard(card, texts);
  return texts.join('\n\n').trim() || '[empty card]';
}

function walkCard(node: unknown, texts: string[]): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;

  const header = obj.header as Record<string, unknown> | undefined;
  const title = extractContent(header?.title);
  if (title) texts.push(title);

  const body = obj.body as { elements?: unknown[] } | undefined;
  if (Array.isArray(body?.elements)) {
    for (const el of body.elements) walkCard(el, texts);
  }

  if (obj.tag === 'markdown' || obj.tag === 'plain_text') {
    const content = extractContent(obj);
    if (content) texts.push(content);
  }

  if (Array.isArray(obj.elements)) {
    for (const el of obj.elements) walkCard(el, texts);
  }
}

function extractContent(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  const content = obj.content;
  if (typeof content !== 'string') return '';
  return content
    .replace(/<font[^>]*>/gi, '')
    .replace(/<\/font>/gi, '')
    .trim();
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
        const text = renderCardToText(card);
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
        const text = renderCardToText(card);
        this.messages.set(id, { conversationId, text });
        this.streamMessageId = id;
        this.streamLineCount = 0;
        this.printReply({ kind: 'card', conversationId, card });
        return id;
      },
      patchCard: async (messageId, card) => {
        const existing = this.messages.get(messageId);
        const text = renderCardToText(card);
        this.messages.set(messageId, {
          conversationId: existing?.conversationId ?? 'cli-local',
          text,
        });
        this.printReply({ kind: 'patch_card', messageId, card });
      },
      recallMessage: async (messageId) => {
        this.messages.delete(messageId);
        console.log(`\n[cli recall ${messageId}]`);
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

  async promptLoop(conversationId = 'cli-local', senderPrincipalId = 'cli-user'): Promise<void> {
    if (!this.handlers) throw new Error('cli ingress not started');
    console.log('CLI chat ready. 输入消息开始对话；输入 `.exit` 退出，`.help` 查看提示。');
    while (this.connected) {
      const text = (await this.rl.question('\n> ')).trim();
      if (!text) continue;
      if (text === '.exit' || text === '.quit') break;
      if (text === '.help') {
        console.log('直接输入自然语言或斜杠命令；`.exit` 退出。');
        continue;
      }
      const msg = this.makeTextMessage(conversationId, senderPrincipalId, text);
      this.messages.set(msg.messageId, { conversationId, text });
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
      console.log(`\n[assistant]\n${reply.text}`);
      return;
    }
    const text = renderCardToText(reply.card);
    if (reply.kind === 'patch_card') {
      this.printStreamingAssistant(text, reply.messageId);
      return;
    }
    if (reply.kind === 'reply_card' || reply.kind === 'card') {
      console.log(`\n[assistant]\n${text}`);
      return;
    }
    this.resetStream();
    console.log(`\n[assistant card]\n${text}`);
  }

  private resetStream(): void {
    this.streamMessageId = undefined;
    this.streamLineCount = 0;
  }

  /** patch_card 在 TTY 下原地刷新，模拟飞书卡片的流式更新。 */
  private printStreamingAssistant(text: string, messageId: string): void {
    const body = `\n[assistant]\n${text}`;
    if (!process.stdout.isTTY) {
      console.log(`\n[assistant update ${messageId}]\n${text}`);
      return;
    }
    if (this.streamMessageId === messageId && this.streamLineCount > 0) {
      process.stdout.write(`\x1b[${this.streamLineCount}A\x1b[0J`);
    } else {
      this.streamMessageId = messageId;
    }
    process.stdout.write(body);
    if (!body.endsWith('\n')) process.stdout.write('\n');
    this.streamLineCount = body.split('\n').length;
  }
}
