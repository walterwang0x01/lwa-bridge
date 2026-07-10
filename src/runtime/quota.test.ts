import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ConfigSchema } from '../lib/config.js';
import {
  clearQuotaProbeCache,
  fallbackProfilesForBucket,
  isQuotaBlocked,
  pickFirstQuotaOkProfile,
  probeAllRuntimeQuotasForDashboard,
  probeRuntimeQuota,
  resetDashboardQuotaRefreshClock,
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
    resetDashboardQuotaRefreshClock();
    vi.useRealTimers();
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
      {
        name: 'openai-fast',
        profile: {
          kind: 'openai-compatible' as const,
          bin: 'openai-compatible',
          model: 'gpt-4o-mini',
          apiBase: 'https://example.com/v1',
          apiKey: 'test-key',
        },
      },
    ];
    const picked = await pickFirstQuotaOkProfile(
      fallbackProfilesForBucket('chat', cfg),
      available,
      cfg,
    );
    expect(picked?.name).toBe('openai-fast');
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

  it('bypassCache re-probes monthly usage', async () => {
    const cfg = ConfigSchema.parse({
      lark: { appId: 'a', appSecret: 'b' },
      runtime: { quota: { monthlyLimits: { 'kiro-cli-acp': 50 } } },
    });
    const profile = { kind: 'kiro-cli-acp' as const, bin: 'kiro-cli' };
    const healthy = await probeRuntimeQuota(profile, 'kiro', cfg, { monthUsage: 10 });
    expect(healthy.state).toBe('healthy');
    const depleted = await probeRuntimeQuota(profile, 'kiro', cfg, {
      monthUsage: 50,
      bypassCache: true,
    });
    expect(depleted.state).toBe('depleted');
  });

  it('dashboard refresh respects min interval', async () => {
    vi.useFakeTimers();
    const cfg = ConfigSchema.parse({
      lark: { appId: 'a', appSecret: 'b' },
      runtime: { quota: { dashboardRefreshMs: 60_000 } },
    });
    const entries = [
      { profileName: 'kiro', profile: { kind: 'kiro-cli-acp' as const, bin: 'kiro-cli' } },
    ];
    const first = await probeAllRuntimeQuotasForDashboard(entries, cfg);
    expect(first[0]?.checkedAt).toBeTruthy();
    vi.advanceTimersByTime(30_000);
    const second = await probeAllRuntimeQuotasForDashboard(entries, cfg);
    expect(second[0]?.checkedAt).toBe(first[0]?.checkedAt);
    vi.advanceTimersByTime(31_000);
    const third = await probeAllRuntimeQuotasForDashboard(entries, cfg);
    expect(third[0]?.checkedAt).not.toBe(first[0]?.checkedAt);
  });
});
