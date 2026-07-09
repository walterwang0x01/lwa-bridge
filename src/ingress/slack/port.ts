import type { IngressPort, IngressTranscribeResult, NormalizedMessage } from '../types.js';
import { larkCardToSlackPayload } from './blocks.js';
import type { SlackIngressState } from './state.js';
import { rememberSlackMessage } from './state.js';

const unsupportedAsr: IngressTranscribeResult = {
  ok: false,
  reason: 'unsupported',
  detail: 'slack ingress',
};

export function createSlackIngressPort(state: SlackIngressState): IngressPort {
  const postCard = async (
    conversationId: string,
    card: object,
    threadTs?: string,
  ): Promise<string> => {
    const { blocks, text } = larkCardToSlackPayload(card);
    const result = await state.client.chat.postMessage({
      channel: conversationId,
      text,
      blocks,
      thread_ts: threadTs,
    });
    const ts = result.ts;
    if (!ts) throw new Error('slack postMessage returned no ts');
    rememberSlackMessage(state, conversationId, ts);
    return ts;
  };

  return {
    channel: 'slack',
    getCachedBotPrincipalId: () => state.botUserId,
    setBotPrincipalId: (id) => {
      state.botUserId = id;
    },
    isConnected: () => state.connected,
    getMessageContent: async (messageId) => {
      const channel = state.messageChannels.get(messageId);
      if (!channel) return [];
      const res = await state.client.conversations.replies({
        channel,
        ts: messageId,
        limit: 50,
      });
      return (res.messages ?? []).map((m: { ts?: string; text?: string }) => ({
        messageId: m.ts ?? '',
        msgType: 'text',
        content: JSON.stringify({ text: m.text ?? '' }),
        mentions: [],
      }));
    },
    replyCard: (replyToMessageId, card) => {
      const channel = state.messageChannels.get(replyToMessageId);
      if (!channel) {
        throw new Error(`slack replyCard: unknown channel for ts=${replyToMessageId}`);
      }
      return postCard(channel, card, replyToMessageId);
    },
    sendText: async (conversationId, text) => {
      const result = await state.client.chat.postMessage({ channel: conversationId, text });
      const ts = result.ts;
      if (!ts) throw new Error('slack sendText returned no ts');
      rememberSlackMessage(state, conversationId, ts);
      return ts;
    },
    sendCard: (conversationId, card) => postCard(conversationId, card),
    patchCard: async (messageId, card) => {
      const channel = state.messageChannels.get(messageId);
      if (!channel) {
        throw new Error(`slack patchCard: unknown channel for ts=${messageId}`);
      }
      const { blocks, text } = larkCardToSlackPayload(card);
      await state.client.chat.update({ channel, ts: messageId, blocks, text });
    },
    recallMessage: async (messageId) => {
      const channel = state.messageChannels.get(messageId);
      if (!channel) return;
      await state.client.chat.delete({ channel, ts: messageId });
      state.messageChannels.delete(messageId);
    },
    downloadInboundMedia: async (_msg: NormalizedMessage) => [],
    transcribeInboundAudio: async () => unsupportedAsr,
  };
}

/** 出站占位（无 token 时 registry 探测用）。 */
export function createSlackIngressPortStub(): IngressPort {
  const fail = async (): Promise<never> => {
    throw new Error('Slack ingress not configured');
  };
  return {
    channel: 'slack',
    getCachedBotPrincipalId: () => '',
    setBotPrincipalId: () => undefined,
    isConnected: () => false,
    getMessageContent: async () => [],
    replyCard: fail,
    sendText: fail,
    sendCard: fail,
    patchCard: fail,
    recallMessage: async () => undefined,
    downloadInboundMedia: async () => [],
    transcribeInboundAudio: async () => unsupportedAsr,
  };
}
