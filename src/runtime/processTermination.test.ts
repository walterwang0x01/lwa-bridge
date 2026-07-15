import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { waitForExitOrKill } from './processTermination.js';

describe('waitForExitOrKill', () => {
  it('resolves without killing a process that exits on its own', async () => {
    const proc = execa('node', ['-e', 'setTimeout(() => process.exit(0), 20)'], {
      reject: false,
    });
    await waitForExitOrKill(proc, 2_000);
    const result = await proc;
    expect(result.exitCode).toBe(0);
    expect(proc.killed).toBe(false);
  });

  it('force-kills a process that ignores SIGTERM within the grace period', async () => {
    // 忽略 SIGTERM，模拟不听话的子进程；SIGKILL 无法被忽略，必定终止。
    const proc = execa(
      'node',
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      { reject: false },
    );
    proc.kill('SIGTERM');
    const start = Date.now();
    await waitForExitOrKill(proc, 300);
    const elapsed = Date.now() - start;
    // 进程忽略 SIGTERM 且用 setInterval 占着事件循环；能在宽限期附近（而非默认几十秒）
    // resolve，且进程 pid 已不存在，就证明兜底强杀生效，没有无限期挂起。
    expect(elapsed).toBeLessThan(1_000);
    await proc.catch(() => undefined);
    let alive = true;
    try {
      process.kill(proc.pid!, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});
