import { describe, expect, it } from 'vitest';
import { createSlackIngressChannel } from './channel.js';
import { createSlackIngressPortStub } from './port.js';

describe('slack ingress', () => {
  it('exposes slack channel id on stub port', () => {
    expect(createSlackIngressPortStub().channel).toBe('slack');
  });

  it('startInbound fails with guidance when tokens missing', async () => {
    const channel = createSlackIngressChannel();
    await expect(channel.startInbound({ onMessage: async () => undefined })).rejects.toThrow(
      /botToken/,
    );
  });
});
