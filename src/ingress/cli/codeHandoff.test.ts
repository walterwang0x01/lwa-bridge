import { describe, it, expect } from 'vitest';
import { resolveCodeHandoffProfile } from './codeHandoff.js';
import type { Config } from '../../lib/config.js';

function baseConfig(overrides?: Partial<Config['runtime']>): Config {
  return {
    lark: { appId: 'x', appSecret: 'y' },
    workspace: { defaultCwd: '/tmp', allowedRoots: ['/tmp'] },
    kiro: {
      binPath: 'kiro-cli',
      model: 'claude-sonnet-4.6',
      timeoutMs: 60000,
      idleTimeoutMinutes: 3,
      sessionTtlHours: 24,
      trustedTools: [],
      systemPromptPrefix: '',
    },
    preferences: {
      requireMentionInGroup: true,
      cardUpdateIntervalMs: 1000,
      logRetentionDays: 7,
    },
    access: { allowFrom: [], allowGroup: [], admins: [] },
    dashboard: { enabled: false, port: 5180 },
    runtime: {
      default: 'auto',
      plan: 'kiro-unlimited+cursor-lite',
      ...overrides,
    },
  } as Config;
}

describe('resolveCodeHandoffProfile', () => {
  it('uses sticky when set', () => {
    const r = resolveCodeHandoffProfile(baseConfig(), 'cursor');
    expect(r.profileName).toBe('cursor');
    expect(r.profile.kind).toBe('cursor-agent-cli');
  });

  it('falls back to plan complexProfile (kiro)', () => {
    const r = resolveCodeHandoffProfile(baseConfig(), 'auto');
    expect(r.profileName).toBe('kiro');
    expect(r.profile.kind).toBe('kiro-cli-acp');
  });

  it('cursor-heavy plan defaults to cursor', () => {
    const r = resolveCodeHandoffProfile(baseConfig({ plan: 'cursor-heavy' }), null);
    expect(r.profileName).toBe('cursor');
  });
});
