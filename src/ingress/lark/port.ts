import type { LarkClient } from '../../lark/client.js';
import type { IngressPort } from '../types.js';
import { fromLarkMessageItem } from './normalize.js';

export function createLarkIngressPort(client: LarkClient): IngressPort {
  return {
    channel: 'lark',
    getCachedBotPrincipalId: () => client.getCachedBotOpenId(),
    setBotPrincipalId: (id) => client.setBotOpenId(id),
    isConnected: () => client.isWsConnected(),
    getMessageContent: async (messageId) => {
      const items = await client.getMessageContent(messageId);
      return items.map(fromLarkMessageItem);
    },
    replyCard: (replyToMessageId, card) => client.replyCard(replyToMessageId, card),
    sendText: (conversationId, text) => client.sendText(conversationId, text),
    sendCard: (conversationId, card) => client.sendCard(conversationId, card),
    patchCard: (messageId, card) => client.patchCard(messageId, card),
  };
}
