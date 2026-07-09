import type { IngressPort, IngressTranscribeResult } from '../types.js';

/** 测试与 mock channel 共用的 IngressPort 工厂。 */
export function createMockIngressPort(overrides?: Partial<IngressPort>): IngressPort {
  const unsupported: IngressTranscribeResult = {
    ok: false,
    reason: 'unsupported',
    detail: 'mock ingress',
  };
  return {
    channel: 'mock',
    getCachedBotPrincipalId: () => 'mock-bot',
    setBotPrincipalId: () => undefined,
    isConnected: () => true,
    getMessageContent: async () => [],
    replyCard: async () => 'mock-reply-1',
    sendText: async () => 'mock-text-1',
    sendCard: async () => 'mock-card-1',
    patchCard: async () => undefined,
    recallMessage: async () => undefined,
    downloadInboundMedia: async () => [],
    transcribeInboundAudio: async () => unsupported,
    ...overrides,
  };
}
