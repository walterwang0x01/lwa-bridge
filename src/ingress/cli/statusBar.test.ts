import { describe, expect, it } from 'vitest';
import {
  buildCliStatusSnapshot,
  formatCliStatusBar,
  formatCliSubStatusLine,
  resolveApprovalMode,
} from './statusBar.js';
import type { Config } from '../../lib/config.js';
import type { ChatSession } from '../../store/sessions.js';

function minimalConfig(): Config {
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
    workspace: { defaultCwd: '/tmp', allowedRoots: ['/tmp'] },
    access: { allowedUsers: [], allowedChats: [], admins: [] },
    preferences: {
      requireMentionInGroup: true,
      cardUpdateIntervalMs: 500,
      logRetentionDays: 7,
    },
    dashboard: { enabled: false, port: 5180 },
    runtime: { default: 'auto', plan: 'kiro-unlimited+cursor-lite' },
    modelRouting: { kiro: {}, cursor: {} },
    quota: {},
  } as unknown as Config;
}

describe('statusBar', () => {
  it('formats Cursor-style primary bar in Auto mode', () => {
    const session: ChatSession = {
      currentCwd: '/tmp/proj',
      sessionsByCwd: {},
      lastActiveAt: 0,
      filesTouched: ['a.ts', 'b.ts'],
      lastUsedRuntimeProfile: 'kiro',
      lastUsedModel: 'claude-test',
    };
    const snap = buildCliStatusSnapshot({
      cwd: '/tmp/proj',
      session,
      config: minimalConfig(),
      ctxPct: 42,
    });
    expect(snap.routeMode).toBe('Auto');
    expect(formatCliStatusBar(snap)).toBe('Auto→kiro · ctx 42% · 2 files · Run Everything');
    expect(formatCliSubStatusLine(snap)).not.toContain('kiro');
    expect(formatCliSubStatusLine(snap)).toContain('claude-test');
  });

  it('shows sticky engine instead of Auto', () => {
    const session: ChatSession = {
      currentCwd: '/tmp',
      sessionsByCwd: {},
      lastActiveAt: 0,
      runtimeProfile: 'cursor',
    };
    const snap = buildCliStatusSnapshot({
      cwd: '/tmp',
      session,
      config: minimalConfig(),
      ctxPct: 10,
    });
    expect(formatCliStatusBar(snap)).toContain('cursor · ctx 10%');
  });

  it('resolveApprovalMode respects session override', () => {
    expect(resolveApprovalMode({ runEverything: false }, true)).toBe('Ask each time');
    expect(resolveApprovalMode({ runEverything: true }, false)).toBe('Run Everything');
  });

  it('includes conduit hint on secondary line', () => {
    const session: ChatSession = {
      currentCwd: '/tmp/proj',
      sessionsByCwd: {},
      lastActiveAt: 0,
    };
    const snap = buildCliStatusSnapshot({
      cwd: '/tmp/proj',
      session,
      config: minimalConfig(),
      ctxPct: 5,
    });
    snap.conduitHint = 'Conduit Wave 1/2 · ✅0 🏃1';
    expect(formatCliSubStatusLine(snap)).toContain('Conduit Wave');
  });
});
