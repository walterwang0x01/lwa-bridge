import type {
  IngressChannel,
  IngressInboundHandlers,
  IngressPort,
  NormalizedCardAction,
  NormalizedMessage,
  NormalizedReply,
} from '../types.js';

export interface MockOutboundRecord {
  at: number;
  reply: NormalizedReply;
}

/**
 * 内存 Ingress，用于无飞书凭据的集成测试。
 * 记录所有出站回复；可通过 emitMessage / emitCardAction 注入入站事件。
 */
export class MockIngressChannel implements IngressChannel {
  readonly id = 'mock' as const;
  readonly port: IngressPort;
  readonly outbound: MockOutboundRecord[] = [];

  private handlers: IngressInboundHandlers | null = null;
  private connected = false;
  private botPrincipalId = 'mock-bot';

  constructor() {
    this.port = {
      channel: 'mock',
      getCachedBotPrincipalId: () => this.botPrincipalId,
      setBotPrincipalId: (id) => {
        this.botPrincipalId = id;
      },
      isConnected: () => this.connected,
      getMessageContent: async () => [],
      replyCard: async (replyToMessageId, card) => {
        this.record({ kind: 'reply_card', replyToMessageId, card });
        return `mock-reply-${this.outbound.length}`;
      },
      sendText: async (conversationId, text) => {
        this.record({ kind: 'text', conversationId, text });
        return `mock-text-${this.outbound.length}`;
      },
      sendCard: async (conversationId, card) => {
        this.record({ kind: 'card', conversationId, card });
        return `mock-card-${this.outbound.length}`;
      },
      patchCard: async (messageId, card) => {
        this.record({ kind: 'patch_card', messageId, card });
      },
    };
  }

  private record(reply: NormalizedReply): void {
    this.outbound.push({ at: Date.now(), reply });
  }

  async startInbound(handlers: IngressInboundHandlers): Promise<void> {
    this.handlers = handlers;
    this.connected = true;
    handlers.onReady?.();
  }

  close(): void {
    this.connected = false;
    this.handlers = null;
  }

  async emitMessage(msg: NormalizedMessage): Promise<void> {
    if (!this.handlers) throw new Error('mock ingress not started');
    await this.handlers.onMessage(msg);
  }

  async emitCardAction(evt: NormalizedCardAction): Promise<void> {
    if (!this.handlers?.onCardAction) throw new Error('mock ingress card handler not set');
    await this.handlers.onCardAction(evt);
  }
}

export function makeMockTextMessage(
  overrides: Partial<NormalizedMessage> & Pick<NormalizedMessage, 'conversationId' | 'text'>,
): NormalizedMessage {
  const now = Date.now();
  const text = overrides.text;
  return {
    channel: 'mock',
    eventId: overrides.eventId ?? `evt-${now}`,
    messageId: overrides.messageId ?? `msg-${now}`,
    conversationId: overrides.conversationId,
    parentId: overrides.parentId,
    rootId: overrides.rootId,
    threadId: overrides.threadId,
    conversationKind: overrides.conversationKind ?? 'p2p',
    senderPrincipalId: overrides.senderPrincipalId ?? 'mock-user',
    messageType: overrides.messageType ?? 'text',
    rawContent: overrides.rawContent ?? JSON.stringify({ text }),
    text,
    mentions: overrides.mentions ?? [],
    receivedAt: overrides.receivedAt ?? now,
  };
}
