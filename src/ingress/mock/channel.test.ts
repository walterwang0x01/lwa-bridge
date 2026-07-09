import { describe, expect, it } from 'vitest';
import { clearIngressRegistry, getIngressChannel, registerIngressChannel } from '../registry.js';
import { MockIngressChannel, makeMockTextMessage } from './channel.js';

describe('mock ingress channel', () => {
  it('records outbound replies without Lark credentials', async () => {
    const mock = new MockIngressChannel();
    registerIngressChannel(mock);

    expect(getIngressChannel('mock')).toBe(mock);

    await mock.startInbound({
      onMessage: async (msg) => {
        await mock.port.sendText(msg.conversationId, `echo:${msg.text}`);
      },
    });

    await mock.emitMessage(makeMockTextMessage({ conversationId: 'chat-mock', text: '/help' }));

    expect(mock.outbound).toHaveLength(1);
    expect(mock.outbound[0]?.reply).toEqual({
      kind: 'text',
      conversationId: 'chat-mock',
      text: 'echo:/help',
    });

    clearIngressRegistry();
  });
});
