import { describe, expect, it } from 'vitest';
import { CursorCliRuntime, isRealModelName } from './cursorCliRuntime.js';
import type { RuntimeProfile } from './types.js';

const profile: RuntimeProfile = {
  kind: 'cursor-agent-cli',
  bin: 'agent',
  force: true,
};

describe('CursorCliRuntime', () => {
  it('exposes cursor-agent-cli kind and streaming capabilities', () => {
    const rt = new CursorCliRuntime(profile, { cwd: process.cwd() });
    expect(rt.kind).toBe('cursor-agent-cli');
    expect(rt.capabilities.streaming).toBe(true);
    expect(rt.capabilities.acp).toBe(false);
  });

  it('newSession returns empty session id (stateless CLI)', async () => {
    const rt = new CursorCliRuntime(profile, { cwd: process.cwd() });
    await expect(rt.newSession(process.cwd())).resolves.toBe('');
  });
});

/**
 * 复现：chooseModelForProfile 曾对未配置模型的 cursor-agent-cli 兜底返回字面字符串
 * 'Auto'，被真实拼进 `--model Auto` 传给 Cursor Agent CLI，导致该次调用挂起无输出
 * （thinking 卡死）。isRealModelName 是最后一层纵深防御：即便上游再次意外把占位符
 * 写进 profile.model，这里也应该识别出来并阻止下发。
 */
describe('isRealModelName (defense in depth against placeholder model names)', () => {
  it('rejects known routing placeholders regardless of case', () => {
    expect(isRealModelName('Auto')).toBe(false);
    expect(isRealModelName('auto')).toBe(false);
    expect(isRealModelName('AUTO')).toBe(false);
    expect(isRealModelName('default')).toBe(false);
    expect(isRealModelName('none')).toBe(false);
  });

  it('rejects empty/undefined values', () => {
    expect(isRealModelName(undefined)).toBe(false);
    expect(isRealModelName('')).toBe(false);
    expect(isRealModelName('   ')).toBe(false);
  });

  it('accepts real model names', () => {
    expect(isRealModelName('claude-opus-4-8')).toBe(true);
    expect(isRealModelName('claude-sonnet-4.6')).toBe(true);
    expect(isRealModelName('gpt-5.6-sol')).toBe(true);
  });
});
