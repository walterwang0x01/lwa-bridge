import { describe, expect, it } from 'vitest';
import { plainFooterKey } from './channel.js';

/**
 * 复现：非 docked 兜底路径（process.stdout.isTTY 假阴性，如 PyCharm 内置终端）下，
 * printFooter 每轮循环都 process.stdout.write 追加打印状态栏，历史状态栏永久堆积，
 * 表现为截图里“两条内容不同的状态栏叠在一起”。
 * 修复：只在状态真正变化时才打印，plainFooterKey 是这次去重判断的核心。
 */
describe('plainFooterKey', () => {
  it('produces the same key for identical footer content', () => {
    const a = plainFooterKey({
      primary: 'Auto',
      secondary: '~/proj · main',
      approval: 'Run Everything',
    });
    const b = plainFooterKey({
      primary: 'Auto',
      secondary: '~/proj · main',
      approval: 'Run Everything',
    });
    expect(a).toBe(b);
  });

  it('produces a different key when the engine changes (Auto -> Auto→openai-fast)', () => {
    const before = plainFooterKey({
      primary: 'Auto→openai-strong',
      secondary: '',
      approval: 'Run Everything',
    });
    const after = plainFooterKey({ primary: 'Auto', secondary: '', approval: 'Run Everything' });
    expect(before).not.toBe(after);
  });

  it('does not collide across the primary/secondary boundary', () => {
    // 用 NUL 分隔，避免 primary="ab" secondary="c" 和 primary="a" secondary="bc" 撞车
    const a = plainFooterKey({ primary: 'ab', secondary: 'c' });
    const b = plainFooterKey({ primary: 'a', secondary: 'bc' });
    expect(a).not.toBe(b);
  });

  it('treats a missing approval the same as an empty string', () => {
    const a = plainFooterKey({ primary: 'Auto', secondary: '' });
    const b = plainFooterKey({ primary: 'Auto', secondary: '', approval: '' });
    expect(a).toBe(b);
  });
});
