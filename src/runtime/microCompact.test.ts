import { describe, expect, it } from 'vitest';
import { microCompactMessages, microCompactText } from './microCompact.js';
import {
  buildFilesRereadBlock,
  extractPathsFromToolInput,
  mergeFilesTouched,
  normalizeArtifactPath,
} from './artifacts.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('microCompact', () => {
  it('truncates long text', () => {
    const t = microCompactText('x'.repeat(20_000), 1000);
    expect(t.length).toBeLessThan(1200);
    expect(t).toContain('micro-compact truncated');
  });

  it('maps messages', () => {
    const out = microCompactMessages([{ role: 'user', content: 'y'.repeat(10_000) }], 500);
    expect(out[0]!.content.length).toBeLessThan(600);
  });
});

describe('artifacts', () => {
  it('extracts path keys', () => {
    expect(extractPathsFromToolInput({ path: 'a.ts', file_path: 'b.ts' })).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('merges filesTouched uniquely', () => {
    expect(mergeFilesTouched(['a'], ['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('normalizes relative paths', () => {
    const abs = normalizeArtifactPath('/tmp/proj', 'src/x.ts');
    expect(abs).toBe(join('/tmp/proj', 'src/x.ts'));
  });

  it('builds reread block', () => {
    const d = join(tmpdir(), `lwa-art-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    const f = join(d, 'note.md');
    writeFileSync(f, 'hello memory');
    try {
      const block = buildFilesRereadBlock(d, [f]);
      expect(block).toContain('Files re-read');
      expect(block).toContain('hello memory');
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
