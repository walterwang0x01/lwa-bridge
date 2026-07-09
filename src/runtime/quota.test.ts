import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ConfigSchema } from '../lib/config.js';
import {
  clearQuotaProbeCache,
  fallbackProfilesForBucket,
  isQuotaBlocked,
  pickFirstQuotaOkProfile,
  probeRuntimeQuota,
} from './quota.js';

vi.mock('./nativeQuotaProbe.js', () => ({
  probeNativeCliQuota: vi.fn(async () => null),
}));

function cfgWithQuota(overrides: Record<string, 'healthy' | 'depleted' | 'unknown' | 'error'>) {
  return ConfigSchema.parse({
    lark: { appId: 'a', appSecret: 'b' },
    runtime: {
      quota: { overrides },
    },
  });
}

describe('quota', () => {
  beforeEach(() => {
    clearQuotaProbeCache();
  });

  it('marks depleted from config override', async () => {
    const cfg = cfgWithQuota({ 'kiro-cli-acp': 'depleted' });
    const status = await probeRuntimeQuota({ kind: 'kiro-cli-acp', bin: 'kiro-cli' }, 'kiro', cfg);
    expect(status.state).toBe('depleted');
    expect(isQuotaBlocked(status)).toBe(true);
  });

  it('picks next profile when preferred is depleted', async () => {
    const cfg = cfgWithQuota({ 'cursor-agent-cli': 'depleted' });
    const available = [
      { name: 'cursor', profile: { kind: 'cursor-agent-cli' as const, bin: 'agent' } },
      { name: 'gemini', profile: { kind: 'gemini-cli' as const, bin: 'gemini' } },
    ];
    const picked = await pickFirstQuotaOkProfile(
      fallbackProfilesForBucket('chat', cfg),
      available,
      cfg,
    );
    expect(picked?.name).toBe('gemini');
  });

  it('uses monthly limits when configured', async () => {
    const cfg = ConfigSchema.parse({
      lark: { appId: 'a', appSecret: 'b' },
      runtime: { quota: { monthlyLimits: { 'kiro-cli-acp': 50 } } },
    });
    const ok = await probeRuntimeQuota({ kind: 'kiro-cli-acp', bin: 'kiro-cli' }, 'kiro', cfg, {
      monthUsage: 10,
    });
    expect(ok.state).toBe('healthy');
    const depleted = await probeRuntimeQuota(
      { kind: 'kiro-cli-acp', bin: 'kiro-cli' },
      'kiro',
      cfg,
      { monthUsage: 50 },
    );
    expect(depleted.state).toBe('depleted');
  });
});
