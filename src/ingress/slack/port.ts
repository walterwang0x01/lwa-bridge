import type { IngressPort, IngressTranscribeResult } from '../types.js';

const unsupportedAsr: IngressTranscribeResult = {
  ok: false,
  reason: 'unsupported',
  detail: 'slack ingress skeleton',
};

/** Slack 出站端口占位（Socket Mode 适配待实现）。 */
export function createSlackIngressPort(): IngressPort {
  return {
    channel: 'slack',
    getCachedBotPrincipalId: () => '',
    setBotPrincipalId: () => undefined,
    isConnected: () => false,
    getMessageContent: async () => [],
    replyCard: async () => {
      throw new Error('Slack ingress not implemented');
    },
    sendText: async () => {
      throw new Error('Slack ingress not implemented');
    },
    sendCard: async () => {
      throw new Error('Slack ingress not implemented');
    },
    patchCard: async () => {
      throw new Error('Slack ingress not implemented');
    },
    recallMessage: async () => undefined,
    downloadInboundMedia: async () => [],
    transcribeInboundAudio: async () => unsupportedAsr,
  };
}
