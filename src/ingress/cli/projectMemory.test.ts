import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import {
  formatProjectMemoryBlock,
  loadProjectMemory,
  PROJECT_MEMORY_FILES,
} from './projectMemory.js';
import { buildCliCodingSystemPrompt } from './codingPrompt.js';

const dirs: string[] = [];

function makeDir(): string {
  const d = join(tmpdir(), `lwa-mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('loadProjectMemory', () => {
  it('loads LWA.md first among known files', () => {
    const d = makeDir();
    writeFileSync(join(d, 'LWA.md'), 'lwa rules');
    writeFileSync(join(d, 'AGENTS.md'), 'agents rules');
    writeFileSync(join(d, 'CLAUDE.md'), 'claude rules');
    const files = loadProjectMemory(d);
    expect(files.map((f) => f.name)).toEqual([...PROJECT_MEMORY_FILES]);
    expect(files[0]!.content).toContain('lwa rules');
  });

  it('skips missing files', () => {
    const d = makeDir();
    writeFileSync(join(d, 'CLAUDE.md'), 'only claude');
    const files = loadProjectMemory(d);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('CLAUDE.md');
  });

  it('truncates oversized files', () => {
    const d = makeDir();
    writeFileSync(join(d, 'LWA.md'), 'x'.repeat(10_000));
    const files = loadProjectMemory(d, { maxPerFile: 100, maxTotalChars: 200 });
    expect(files[0]!.content.length).toBeLessThanOrEqual(120);
    expect(files[0]!.content).toContain('[truncated]');
  });
});

describe('buildCliCodingSystemPrompt + memory', () => {
  it('injects project memory into coding prompt', () => {
    const d = makeDir();
    writeFileSync(join(d, 'AGENTS.md'), 'Always use pnpm');
    const p = buildCliCodingSystemPrompt({
      cwd: d,
      profileName: 'kiro',
    });
    expect(p).toContain('Project memory');
    expect(p).toContain('AGENTS.md');
    expect(p).toContain('Always use pnpm');
  });

  it('accepts injected memory block for tests', () => {
    const p = buildCliCodingSystemPrompt({
      cwd: '/tmp',
      profileName: 'kiro',
      projectMemoryBlock: '### injected\nhi',
    });
    expect(p).toContain('### injected');
  });
});

describe('formatProjectMemoryBlock', () => {
  it('returns empty for no files', () => {
    expect(formatProjectMemoryBlock([])).toBe('');
  });
});
