import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRunSummary, summarizeRunState } from './summary.js';

const TMP = mkdtempSync(join(tmpdir(), 'lwa-conduit-summary-'));

beforeAll(() => {
  const dir = join(TMP, '.lwa-conduit');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'run-state.json'),
    JSON.stringify({
      version: 1,
      base_branch: 'main',
      tasks: {
        a: { status: 'passed', branch: 'lwa-conduit/a', attempts: 1 },
        b: { status: 'failed', branch: 'lwa-conduit/b', attempts: 3 },
        c: { status: 'skipped' },
      },
    }),
  );
  writeFileSync(join(dir, 'review.md'), '# review\nverdict: PASS\n');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('summarizeRunState', () => {
  it('reads .lwa-conduit run-state and review', () => {
    const s = summarizeRunState(TMP);
    expect(s).not.toBeNull();
    expect(s!.passed).toEqual(['a']);
    expect(s!.failed).toEqual(['b']);
    expect(s!.skipped).toEqual(['c']);
    expect(s!.baseBranch).toBe('main');
    expect(s!.reviewSnippet).toContain('PASS');
    const text = formatRunSummary(s!);
    expect(text).toContain('lwa-conduit/a');
    expect(text).toContain('✅ 1');
  });

  it('falls back to .kiro-conduit', () => {
    const legacyRoot = mkdtempSync(join(tmpdir(), 'lwa-conduit-legacy-'));
    try {
      const dir = join(legacyRoot, '.kiro-conduit');
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'run-state.json'),
        JSON.stringify({
          version: 1,
          base_branch: 'dev',
          tasks: { x: { status: 'passed', branch: 'kiro-conduit/x' } },
        }),
      );
      const s = summarizeRunState(legacyRoot);
      expect(s?.dirName).toBe('.kiro-conduit');
      expect(s?.passed).toEqual(['x']);
    } finally {
      rmSync(legacyRoot, { recursive: true, force: true });
    }
  });
});
