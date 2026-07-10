/**
 * Ingress 层：渠道无关的消息与会话类型。
 * core/dispatcher 只依赖本模块，不直接依赖飞书 SDK。
 */

export type ChannelId = 'lark' | 'mock' | 'slack' | 'cli';

export type ConversationKind = 'p2p' | 'group' | 'topic_group' | 'unknown';

export interface NormalizedMention {
  key: string;
  principalId?: string;
  name: string;
}

/** 渠道无关的入站消息（由 ingress 适配器从渠道事件归一化）。 */
export interface NormalizedMessage {
  channel: ChannelId;
  eventId: string;
  messageId: string;
  conversationId: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
  conversationKind: ConversationKind;
  senderPrincipalId: string;
  messageType: string;
  rawContent: string;
  text: string;
  mentions: NormalizedMention[];
  receivedAt: number;
}

/** 渠道无关的卡片按钮回调。 */
export interface NormalizedCardAction {
  channel: ChannelId;
  messageId: string;
  conversationId: string;
  senderPrincipalId: string;
  value: Record<string, unknown>;
  formValue?: Record<string, unknown>;
  token?: string;
  receivedAt: number;
}

export interface NormalizedMessageItem {
  messageId: string;
  upperMessageId?: string;
  msgType: string;
  senderName?: string;
  senderType?: string;
  content: string;
  mentions: Array<{ key: string; name: string }>;
}

export type NormalizedReply =
  | { kind: 'text'; conversationId: string; text: string }
  | { kind: 'card'; conversationId: string; card: object }
  | { kind: 'reply_card'; replyToMessageId: string; card: object }
  | { kind: 'patch_card'; messageId: string; card: object };

export type IngressTranscribeResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason:
        | 'ffmpeg-missing'
        | 'ffmpeg-failed'
        | 'too-long'
        | 'api-failed'
        | 'empty'
        | 'unsupported';
      detail?: string;
    };

/**
 * 出站端口：dispatcher / CardRenderer 通过此接口回发消息，不感知具体 IM SDK。
 */
export interface IngressPort {
  readonly channel: ChannelId;
  getCachedBotPrincipalId(): string;
  setBotPrincipalId(principalId: string): void;
  isConnected(): boolean;
  getMessageContent(messageId: string): Promise<NormalizedMessageItem[]>;
  replyCard(replyToMessageId: string, card: object): Promise<string>;
  sendText(conversationId: string, text: string): Promise<string>;
  sendCard(conversationId: string, card: object): Promise<string>;
  patchCard(messageId: string, card: object): Promise<void>;
  recallMessage(messageId: string): Promise<void>;
  downloadInboundMedia(msg: NormalizedMessage): Promise<string[]>;
  transcribeInboundAudio(audioPath: string): Promise<IngressTranscribeResult>;
}

export interface IngressChannel {
  readonly id: ChannelId;
  readonly port: IngressPort;
  /** 启动入站监听（飞书 WebSocket 等）；mock 为 no-op 或测试钩子。 */
  startInbound(handlers: IngressInboundHandlers): Promise<void>;
  close(): void;
}

export interface IngressInboundHandlers {
  onMessage: (msg: NormalizedMessage) => void | Promise<void>;
  onCardAction?: (evt: NormalizedCardAction) => void | Promise<void>;
  onReady?: () => void;
  onReconnected?: () => void;
}
