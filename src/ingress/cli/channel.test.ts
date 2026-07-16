import { describe, expect, it } from 'vitest';
import { LineQueue, plainFooterKey } from './channel.js';

/**
 * 复现：非 docked fallback 路径下，用户在上一条消息处理期间（onMessage 的
 * await 阶段）提交了下一行输入，此时没有任何 question() 在等待接收这一行。
 * 用 rl.question() 的一次性 once('line', …) 监听器时，这个 'line' 事件会在
 * 无人监听的情况下触发并永久丢失，表现为用户输入被回显却从未被处理
 * （截图现象 "> hi> > hi>" 的真实成因）。
 * 修复：LineQueue 用持久监听 + 队列，保证输入不会丢失。
 */
describe('LineQueue', () => {
  it('resolves take() immediately when a line was already pushed', async () => {
    const q = new LineQueue();
    q.push('hi');
    await expect(q.take()).resolves.toBe('hi');
  });

  it('resolves take() with the next pushed line when called before push (normal case)', async () => {
    const q = new LineQueue();
    const pending = q.take();
    q.push('hi');
    await expect(pending).resolves.toBe('hi');
  });

  it('does not lose a line pushed while no take() is waiting (typeahead during processing)', async () => {
    const q = new LineQueue();
    // 模拟：用户在 onMessage 处理期间提交了下一行，此时没有 take() 在等待。
    q.push('second');
    // 处理完成后才调用 take()：应该立刻拿到之前排队的内容，而不是永久丢失或挂起。
    await expect(q.take()).resolves.toBe('second');
  });

  it('preserves FIFO order across multiple lines pushed before any take()', async () => {
    const q = new LineQueue();
    q.push('first');
    q.push('second');
    q.push('third');
    await expect(q.take()).resolves.toBe('first');
    await expect(q.take()).resolves.toBe('second');
    await expect(q.take()).resolves.toBe('third');
  });

  it('each take() consumes exactly one line, not duplicating it for a later take()', async () => {
    const q = new LineQueue();
    q.push('only-once');
    await expect(q.take()).resolves.toBe('only-once');
    // 队列已空，第二次 take() 必须挂起等待新的 push()，不能返回同一行。
    const second = q.take();
    let resolved = false;
    second.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    q.push('new-line');
    await expect(second).resolves.toBe('new-line');
  });
});

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
