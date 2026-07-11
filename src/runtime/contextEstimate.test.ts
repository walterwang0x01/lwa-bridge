import { describe, expect, it } from 'vitest';
import { estimateContextChars } from './autoCompact.js';

describe('context estimate pct math', () => {
  it('pct scales with threshold', () => {
    const chars = estimateContextChars([{ role: 'user', content: 'x'.repeat(40_000) }]);
    const threshold = 80_000;
    const pct = Math.min(999, Math.round((chars / threshold) * 100));
    expect(pct).toBeGreaterThanOrEqual(50);
    expect(pct).toBeLessThanOrEqual(55);
  });
});
