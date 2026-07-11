import { describe, expect, it } from 'vitest';
import { estimateContextChars, estimateTokensFromChars, shouldAutoCompact } from './autoCompact.js';
import { buildSubagentPrompt } from './subagents.js';

describe('autoCompact', () => {
  it('estimates chars', () => {
    const n = estimateContextChars(
      [
        { role: 'user', content: 'abcd' },
        { role: 'assistant', content: 'efgh' },
      ],
      ['xyz'],
    );
    expect(n).toBeGreaterThan(8);
  });

  it('estimates tokens as chars/4', () => {
    expect(estimateTokensFromChars(4000)).toBe(1000);
  });

  it('triggers only when over threshold and cooled down', () => {
    expect(shouldAutoCompact({ chars: 100, thresholdChars: 80_000, enabled: true })).toBe(false);
    expect(shouldAutoCompact({ chars: 90_000, thresholdChars: 80_000, enabled: true })).toBe(true);
    expect(
      shouldAutoCompact({
        chars: 90_000,
        thresholdChars: 80_000,
        enabled: true,
        lastCompactAt: Date.now(),
        cooldownMs: 60_000,
      }),
    ).toBe(false);
    expect(shouldAutoCompact({ chars: 90_000, thresholdChars: 80_000, enabled: false })).toBe(
      false,
    );
  });
});

describe('subagents', () => {
  it('builds explore prompt as read-only', () => {
    const p = buildSubagentPrompt('explore', 'where is auth?');
    expect(p).toContain('SUBAGENT: explore');
    expect(p).toContain('Do NOT edit');
    expect(p).toContain('where is auth?');
  });
});
