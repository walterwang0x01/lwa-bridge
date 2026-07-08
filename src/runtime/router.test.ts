import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../lib/config.js';
import { chooseRuntimeProfile, complexityScore } from './router.js';

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
  it('显式 profile 优先', () => {
    const cfg = makeConfig();
    const picked = chooseRuntimeProfile(cfg, { prompt: 'hi' }, 'kiro');
    expect(picked.profileName).toBe('kiro');
    expect(picked.reason).toBe('explicit-profile');
  });

  it('简单任务优先 cursor', () => {
    const cfg = makeConfig();
    const picked = chooseRuntimeProfile(cfg, { prompt: '帮我总结这段话' });
    expect(['cursor', 'kiro']).toContain(picked.profileName);
  });

  it('复杂任务优先 kiro', () => {
    const cfg = makeConfig();
    const picked = chooseRuntimeProfile(cfg, {
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
});
