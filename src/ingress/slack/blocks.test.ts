import { describe, expect, it } from 'vitest';
import { buildAckCard } from '../../card/builders.js';
import { larkCardToSlackPayload } from './blocks.js';

describe('slack blocks', () => {
  it('maps ack card header and body to mrkdwn section', () => {
    const card = buildAckCard({ state: 'done', body: 'Hello **world**' });
    const { blocks, text } = larkCardToSlackPayload(card);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks[0]?.type).toBe('section');
    expect(text).toContain('已完成');
    expect(text).toContain('Hello');
  });
});
