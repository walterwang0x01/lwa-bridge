import { describe, expect, it } from 'vitest';
import { compactMessages } from './compact.js';
import { ConfigSchema } from '../lib/config.js';

describe('compactMessages', () => {
  it('falls back to heuristic without gateway', async () => {
    const cfg = ConfigSchema.parse({ lark: { appId: 'a', appSecret: 'b' } });
    const { summary, via } = await compactMessages(
      cfg,
      [
        { role: 'user', content: 'add jwt login' },
        { role: 'assistant', content: 'I will edit auth.ts' },
      ],
      'auth',
    );
    expect(via).toBe('heuristic');
    expect(summary).toContain('compacted');
    expect(summary).toContain('auth');
    expect(summary).toContain('jwt');
  });
});
