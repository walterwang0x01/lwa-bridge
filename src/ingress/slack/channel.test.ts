import { describe, expect, it } from 'vitest';
import { createSlackIngressChannel } from './channel.js';
import { createSlackIngressPort } from './port.js';

describe('slack ingress skeleton', () => {
  it('exposes slack channel id on port', () => {
    expect(createSlackIngressPort().channel).toBe('slack');
  });

  it('startInbound fails with guidance when tokens missing', async () => {
    const channel = createSlackIngressChannel();
    await expect(channel.startInbound({ onMessage: async () => undefined })).rejects.toThrow(
      /botToken/,
    );
  });
});
