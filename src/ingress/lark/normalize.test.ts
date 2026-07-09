import { describe, expect, it } from 'vitest';
import {
  fromLarkCardAction,
  fromLarkMessage,
  toCardActionEvent,
  toIncomingMessage,
} from './normalize.js';
import type { CardActionEvent, IncomingMessage } from '../../lark/types.js';

function sampleIncoming(): IncomingMessage {
  return {
    eventId: 'evt-1',
    messageId: 'msg-1',
    chatId: 'chat-1',
    chatType: 'p2p',
    senderOpenId: 'ou_user',
    messageType: 'text',
    rawContent: '{"text":"hello"}',
    text: 'hello',
    mentions: [{ key: '@_user_1', openId: 'ou_bot', name: 'bot' }],
    receivedAt: 1_700_000_000_000,
  };
}

describe('lark normalize', () => {
  it('roundtrips message fields', () => {
    const incoming = sampleIncoming();
    const normalized = fromLarkMessage(incoming);
    expect(normalized.channel).toBe('lark');
    expect(normalized.conversationId).toBe('chat-1');
    expect(normalized.senderPrincipalId).toBe('ou_user');
    const back = toIncomingMessage(normalized);
    expect(back.chatId).toBe(incoming.chatId);
    expect(back.senderOpenId).toBe(incoming.senderOpenId);
    expect(back.text).toBe('hello');
  });

  it('roundtrips card action', () => {
    const evt: CardActionEvent = {
      messageId: 'm1',
      chatId: 'c1',
      senderOpenId: 'u1',
      value: { action: 'model.show' },
      receivedAt: 123,
    };
    const normalized = fromLarkCardAction(evt);
    const back = toCardActionEvent(normalized);
    expect(back.value.action).toBe('model.show');
  });
});
