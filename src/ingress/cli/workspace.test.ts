import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findGitRoot, resolveCliLaunchCwd, shortenHomePath } from './workspace.js';
import type { Config } from '../../lib/config.js';

function minimalConfig(allowedRoots: string[], defaultCwd: string): Config {
  return {
    ingress: { channels: ['lark'] },
    lark: { appId: 'x', appSecret: 'y' },
    kiro: {
      binPath: 'kiro-cli',
      trustedTools: [],
      timeoutMs: 1000,
      idleTimeoutMinutes: 5,
      sessionTtlHours: 4,
    },
    workspace: { defaultCwd, allowedRoots },
    access: { allowedUsers: [], allowedChats: [], admins: [] },
    preferences: {
      requireMentionInGroup: true,
      cardUpdateIntervalMs: 500,
      logRetentionDays: 7,
    },
    dashboard: { enabled: false, port: 5180 },
    runtime: {},
    modelRouting: { kiro: {}, cursor: {} },
    quota: {},
  } as unknown as Config;
}

describe('cli workspace', () => {
  it('findGitRoot walks up to .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-git-'));
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(root, '.git'));
    expect(findGitRoot(nested)).toBe(root);
    rmSync(root, { recursive: true, force: true });
  });

  it('resolveCliLaunchCwd prefers launch cwd when allowed', () => {
    const root = mkdtempSync(join(tmpdir(), 'lwa-cwd-'));
    const cfg = minimalConfig([root], join(root, 'default'));
    mkdirSync(join(root, 'default'), { recursive: true });
    const project = join(root, 'proj');
    mkdirSync(project);
    expect(resolveCliLaunchCwd(cfg, project)).toBe(project);
    rmSync(root, { recursive: true, force: true });
  });

  it('shortenHomePath uses ~', () => {
    const home = process.env['HOME'] ?? '';
    if (home) expect(shortenHomePath(join(home, 'x'))).toBe('~/x');
  });
});
