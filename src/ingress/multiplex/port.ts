/**
 * 按 conversationId 把出站消息路由到对应渠道的 IngressPort。
 * 用于同一 Dispatcher 同时服务飞书 + 本地 CLI 等多入口。
 */
import type { IngressPort, IngressTranscribeResult, NormalizedMessage } from '../types.js';

export class ConversationIngressRouter implements IngressPort {
  readonly channel;
  private readonly fallback: IngressPort;
  private readonly bindings = new Map<string, IngressPort>();
  private readonly messagePorts = new Map<string, IngressPort>();

  constructor(fallback: IngressPort) {
    this.fallback = fallback;
    this.channel = fallback.channel;
  }

  bind(conversationId: string, port: IngressPort): void {
    this.bindings.set(conversationId, port);
  }

  private trackMessage(messageId: string, port: IngressPort): void {
    this.messagePorts.set(messageId, port);
  }

  private portForConversation(conversationId?: string): IngressPort {
    if (conversationId && this.bindings.has(conversationId)) {
      return this.bindings.get(conversationId)!;
    }
    return this.fallback;
  }

  private portForMessage(messageId: string): IngressPort {
    return this.messagePorts.get(messageId) ?? this.fallback;
  }

  getCachedBotPrincipalId(): string {
    return this.fallback.getCachedBotPrincipalId();
  }

  setBotPrincipalId(principalId: string): void {
    this.fallback.setBotPrincipalId(principalId);
  }

  isConnected(): boolean {
    return this.fallback.isConnected();
  }

  getMessageContent(messageId: string): Promise<import('../types.js').NormalizedMessageItem[]> {
    return this.fallback.getMessageContent(messageId);
  }

  replyCard(replyToMessageId: string, card: object): Promise<string> {
    const port = this.portForMessage(replyToMessageId);
    return port.replyCard(replyToMessageId, card).then((id) => {
      this.trackMessage(id, port);
      return id;
    });
  }

  sendText(conversationId: string, text: string): Promise<string> {
    const port = this.portForConversation(conversationId);
    return port.sendText(conversationId, text).then((id) => {
      this.trackMessage(id, port);
      return id;
    });
  }

  sendCard(conversationId: string, card: object): Promise<string> {
    const port = this.portForConversation(conversationId);
    return port.sendCard(conversationId, card).then((id) => {
      this.trackMessage(id, port);
      return id;
    });
  }

  patchCard(messageId: string, card: object): Promise<void> {
    return this.portForMessage(messageId).patchCard(messageId, card);
  }

  recallMessage(messageId: string): Promise<void> {
    return this.fallback.recallMessage(messageId);
  }

  downloadInboundMedia(msg: NormalizedMessage): Promise<string[]> {
    return this.portForConversation(msg.conversationId).downloadInboundMedia(msg);
  }

  transcribeInboundAudio(audioPath: string): Promise<IngressTranscribeResult> {
    return this.fallback.transcribeInboundAudio(audioPath);
  }
}
