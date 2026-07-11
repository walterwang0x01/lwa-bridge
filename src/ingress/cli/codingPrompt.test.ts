import { describe, expect, it } from 'vitest';
import { buildCliCodingSystemPrompt } from './codingPrompt.js';

describe('buildCliCodingSystemPrompt', () => {
  it('marks local coding and forbids Feishu persona', () => {
    const p = buildCliCodingSystemPrompt({
      cwd: '/tmp/proj',
      profileName: 'openai-fast',
      model: 'haiku',
    });
    expect(p).toContain('NOT a Feishu');
    expect(p).toContain('/tmp/proj');
    expect(p).toContain('openai-fast');
    expect(p).toContain('local coding agent');
    expect(p).toContain('NOT a Feishu');
  });
});
