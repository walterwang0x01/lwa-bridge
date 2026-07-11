import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { formatGlobalMemoryBlock, loadGlobalMemory } from './globalMemory.js';
import { DATA_DIR } from '../../lib/paths.js';

const created: string[] = [];

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('globalMemory', () => {
  it('loads md files from ~/.lwa/memory', () => {
    const dir = join(DATA_DIR, 'memory');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `lwa-test-${Date.now()}.md`);
    writeFileSync(f, 'prefer pnpm');
    created.push(f);
    const files = loadGlobalMemory();
    expect(files.some((x) => x.content.includes('prefer pnpm'))).toBe(true);
    expect(formatGlobalMemoryBlock(files)).toContain('Global memory');
  });
});
