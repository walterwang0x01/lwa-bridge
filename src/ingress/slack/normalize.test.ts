import { describe, expect, it } from 'vitest';
import { fromSlackBlockAction, fromSlackMessage, slackTextToPlain } from './normalize.js';

describe('slack normalize', () => {
  it('strips mention markup', () => {
    expect(slackTextToPlain('<@U123> hello')).toBe('hello');
  });

  it('maps generic message event', () => {
    const msg = fromSlackMessage(
      {
        type: 'message',
        channel: 'CCHAN',
        user: 'UUSER',
        ts: '1234.5678',
        text: '<@UBOT> ping',
      },
      'evt-1',
    );
    expect(msg?.channel).toBe('slack');
    expect(msg?.conversationId).toBe('CCHAN');
    expect(msg?.messageId).toBe('1234.5678');
    expect(msg?.text).toBe('ping');
    expect(msg?.conversationKind).toBe('group');
  });

  it('maps block button action value json', () => {
    const evt = fromSlackBlockAction(
      {
        type: 'block_actions',
        channel: { id: 'C1' },
        message: { ts: '99.1' },
        user: { id: 'U1' },
      },
      {
        type: 'button',
        action_id: 'a1',
        block_id: 'b1',
        text: { type: 'plain_text', text: 'Go' },
        value: JSON.stringify({ action: 'model.show' }),
      },
    );
    expect(evt?.value.action).toBe('model.show');
  });
});
