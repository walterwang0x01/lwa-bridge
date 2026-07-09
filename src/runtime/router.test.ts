import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../lib/config.js';
import { chooseModelForProfile, chooseRuntimeProfile, complexityScore } from './router.js';
import * as registry from './registry.js';
import { clearQuotaProbeCache } from './quota.js';

function makeConfig() {
  return ConfigSchema.parse({
    lark: { appId: 'a', appSecret: 'b' },
    runtime: {
      default: 'auto',
      router: {
        mode: 'smart',
        lark: { simpleProfile: 'cursor', complexProfile: 'kiro', conduitProfile: 'kiro' },
      },
    },
  });
}

describe('chooseRuntimeProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearQuotaProbeCache();
  });

  it('显式 profile 优先', async () => {
    vi.spyOn(registry, 'discoverRuntimeRegistry').mockResolvedValue([
      {
        profileName: 'kiro',
        profile: { kind: 'kiro-cli-acp', bin: 'kiro-cli' },
        available: true,
        models: ['claude-sonnet-5'],
        defaultModel: 'claude-sonnet-5',
      },
    ]);
    const cfg = makeConfig();
    const picked = await chooseRuntimeProfile(cfg, { prompt: 'hi' }, 'kiro');
    expect(picked.profileName).toBe('kiro');
    expect(picked.reason).toBe('explicit-profile');
  });

  it('简单任务优先 cursor', async () => {
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
    ]);
    const cfg = makeConfig();
    const picked = await chooseRuntimeProfile(cfg, { prompt: '帮我总结这段话' });
    expect(picked.profileName).toBe('cursor');
  });

  it('cursor 配额耗尽时 fallback 到 gemini', async () => {
    vi.spyOn(registry, 'discoverRuntimeRegistry').mockResolvedValue([
      {
        profileName: 'cursor',
        profile: { kind: 'cursor-agent-cli', bin: 'agent', force: true },
        available: true,
        models: [],
      },
      {
        profileName: 'gemini',
        profile: { kind: 'gemini-cli', bin: 'gemini', force: true },
        available: true,
        models: [],
      },
    ]);
    const cfg = ConfigSchema.parse({
      lark: { appId: 'a', appSecret: 'b' },
      runtime: {
        default: 'auto',
        router: {
          mode: 'smart',
          lark: { simpleProfile: 'cursor', complexProfile: 'kiro', conduitProfile: 'kiro' },
        },
        quota: { overrides: { 'cursor-agent-cli': 'depleted' } },
      },
    });
    const picked = await chooseRuntimeProfile(cfg, { prompt: '帮我总结这段话' });
    expect(picked.profileName).toBe('gemini');
    expect(picked.reason).toContain('quota_fallback');
  });

  it('复杂任务优先 kiro', async () => {
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
    ]);
    const cfg = makeConfig();
    const picked = await chooseRuntimeProfile(cfg, {
      prompt: '请在 monorepo 里做跨模块重构，先分析架构，再修改多个文件，最后 review',
    });
    expect(picked.profileName).toBe('kiro');
  });

  it('复杂度分数会随着任务变复杂而上升', () => {
    const cfg = makeConfig();
    const simple = complexityScore(cfg, { prompt: '帮我总结这段话' });
    const complex = complexityScore(cfg, {
      prompt: '请在 monorepo 里做跨模块重构，先分析架构，再修改多个文件，最后 review',
    });
    expect(complex).toBeGreaterThan(simple);
  });

  it('simpleTier 配置会影响 Kiro 选模偏好', async () => {
    vi.spyOn(registry, 'discoverRuntimeRegistry').mockResolvedValue([
      {
        profileName: 'kiro',
        profile: { kind: 'kiro-cli-acp', bin: 'kiro-cli' },
        available: true,
        models: ['claude-sonnet-4.6', 'claude-sonnet-5', 'claude-opus-4.8'],
        defaultModel: 'claude-sonnet-4.6',
      },
    ]);
    const cfg = ConfigSchema.parse({
      lark: { appId: 'a', appSecret: 'b' },
      modelRouting: { kiro: { simpleTier: 'strong' } },
    });
    const decision = await chooseModelForProfile(
      cfg,
      { kind: 'kiro-cli-acp', bin: 'kiro-cli' },
      { prompt: '帮我总结这段话' },
    );
    expect(decision.selectedModel).toBe('claude-sonnet-5');
  });
});
