import { describe, expect, it, beforeEach } from 'vitest';
import { ConfigSchema } from '../lib/config.js';
import { resolveModeRouteTable, resolvePlanId } from './planProfiles.js';
import { GatewayHealth } from './gatewayHealth.js';
import { chooseRuntimeProfile } from './router.js';
import * as registry from './registry.js';
import { vi } from 'vitest';
import { clearQuotaProbeCache } from './quota.js';

function baseCfg(extra?: Record<string, unknown>) {
  return ConfigSchema.parse({
    lark: { appId: 'a', appSecret: 'b' },
    runtime: {
      default: 'auto',
      plan: 'kiro-unlimited+cursor-lite',
      router: {
        mode: 'smart',
        lark: {
          simpleProfile: 'openai-fast',
          complexProfile: 'openai-strong',
          conduitProfile: 'kiro',
        },
      },
      ...extra,
    },
  });
}

describe('planProfiles', () => {
  it('defaults to kiro-unlimited+cursor-lite', () => {
    const cfg = ConfigSchema.parse({ lark: { appId: 'a', appSecret: 'b' } });
    expect(resolvePlanId(cfg)).toBe('kiro-unlimited+cursor-lite');
  });

  it('code mode prefers kiro for complex, cursor for simple', () => {
    const cfg = baseCfg();
    const code = resolveModeRouteTable(cfg, 'code');
    expect(code.simpleProfile).toBe('cursor');
    expect(code.complexProfile).toBe('kiro');
    expect(code.gatewayOptional).toBe(true);
  });

  it('lark mode still respects router.lark overrides', () => {
    const cfg = baseCfg();
    const lark = resolveModeRouteTable(cfg, 'lark');
    expect(lark.simpleProfile).toBe('openai-fast');
    expect(lark.complexProfile).toBe('openai-strong');
  });
});

describe('GatewayHealth', () => {
  it('opens circuit after threshold failures', () => {
    const h = new GatewayHealth({ failureThreshold: 2, cooldownMs: 60_000 });
    const profile = {
      kind: 'openai-compatible' as const,
      apiBase: 'https://example.test/v1',
      apiKey: 'k',
    };
    expect(h.allows(profile, 'openai-fast')).toBe(true);
    h.recordFailure(profile, 'openai-fast', '500');
    expect(h.allows(profile, 'openai-fast')).toBe(true);
    h.recordFailure(profile, 'openai-fast', '500');
    expect(h.allows(profile, 'openai-fast')).toBe(false);
    expect(h.getState(profile, 'openai-fast')).toBe('open');
  });
});

describe('chooseRuntimeProfile code mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearQuotaProbeCache();
  });

  it('code complex task picks kiro even if lark router prefers openai', async () => {
    vi.spyOn(registry, 'discoverRuntimeRegistry').mockResolvedValue([
      {
        profileName: 'kiro',
        profile: { kind: 'kiro-cli-acp', bin: 'kiro-cli' },
        available: true,
        models: ['claude-sonnet-5'],
        defaultModel: 'claude-sonnet-5',
      },
      {
        profileName: 'cursor',
        profile: { kind: 'cursor-agent-cli', bin: 'agent', force: true },
        available: true,
        models: [],
      },
      {
        profileName: 'openai-fast',
        profile: {
          kind: 'openai-compatible',
          bin: 'openai-compatible',
          apiBase: 'https://example.test/v1',
          apiKey: 'k',
          model: 'haiku',
        },
        available: true,
        models: ['haiku'],
      },
    ]);
    const cfg = baseCfg();
    const picked = await chooseRuntimeProfile(
      cfg,
      {
        prompt:
          '请重构整个 monorepo 的认证模块：多文件修改、写测试、分 1. 2. 3. 步完成，并做架构 review',
      },
      undefined,
      { harnessMode: 'code' },
    );
    expect(picked.profileName).toBe('kiro');
    expect(picked.reason).toContain('mode=code');
  });

  it('skips openai when circuit open', async () => {
    const health = new GatewayHealth({ failureThreshold: 1 });
    const openaiProfile = {
      kind: 'openai-compatible' as const,
      bin: 'openai-compatible',
      apiBase: 'https://example.test/v1',
      apiKey: 'k',
      model: 'haiku',
    };
    health.recordFailure(openaiProfile, 'openai-fast', 'down');

    vi.spyOn(registry, 'discoverRuntimeRegistry').mockResolvedValue([
      {
        profileName: 'kiro',
        profile: { kind: 'kiro-cli-acp', bin: 'kiro-cli' },
        available: true,
        models: [],
      },
      {
        profileName: 'openai-fast',
        profile: openaiProfile,
        available: true,
        models: ['haiku'],
      },
    ]);
    const cfg = baseCfg();
    const picked = await chooseRuntimeProfile(cfg, { prompt: 'hi' }, undefined, {
      harnessMode: 'chat',
      health,
    });
    expect(picked.profileName).not.toBe('openai-fast');
    expect(picked.reason).toContain('gateway_skip');
  });
});
