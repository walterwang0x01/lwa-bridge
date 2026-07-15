import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpPool } from './acpPool.js';
import { AcpClient } from './acp/client.js';

function makeFakeClient() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    newSession: vi.fn().mockResolvedValue('sess-1'),
    loadSession: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AcpClient;
}

describe('AcpPool idle timer lease', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not recycle a client while a turn is still leased, even past idleMs', async () => {
    const fakeClient = makeFakeClient();
    vi.spyOn(AcpClient, 'spawn').mockReturnValue(fakeClient);

    const pool = new AcpPool({ clientConfig: { binPath: 'kiro-cli' }, idleMs: 1_000 });
    const { client } = await pool.acquire('chat-1', { cwd: '/tmp' });
    expect(client).toBe(fakeClient);

    // 长任务运行中：推进远超 idleMs 的时间，进程不应被回收
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fakeClient.close).not.toHaveBeenCalled();

    // turn 结束才 release；此后空闲计时器才真正开始计时
    pool.release('chat-1');
    await vi.advanceTimersByTimeAsync(999);
    expect(fakeClient.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  it('recycles after idleMs once released and not re-acquired', async () => {
    const fakeClient = makeFakeClient();
    vi.spyOn(AcpClient, 'spawn').mockReturnValue(fakeClient);

    const pool = new AcpPool({ clientConfig: { binPath: 'kiro-cli' }, idleMs: 500 });
    await pool.acquire('chat-1', { cwd: '/tmp' });
    pool.release('chat-1');

    await vi.advanceTimersByTimeAsync(499);
    expect(fakeClient.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });

  it('concurrent acquire/release pairs keep the process alive until all leases are returned', async () => {
    const fakeClient = makeFakeClient();
    vi.spyOn(AcpClient, 'spawn').mockReturnValue(fakeClient);

    const pool = new AcpPool({ clientConfig: { binPath: 'kiro-cli' }, idleMs: 100 });
    await pool.acquire('chat-1', { cwd: '/tmp' });
    await pool.acquire('chat-1', { cwd: '/tmp' }); // 第二个并发 turn 复用同一 client

    pool.release('chat-1'); // 第一个 turn 结束，但第二个仍在跑
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fakeClient.close).not.toHaveBeenCalled();

    pool.release('chat-1'); // 第二个 turn 结束，leaseCount 归零
    await vi.advanceTimersByTimeAsync(99);
    expect(fakeClient.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fakeClient.close).toHaveBeenCalledTimes(1);
  });
});
