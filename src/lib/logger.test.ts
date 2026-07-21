import { mkdtempSync, rmSync, chmodSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('logger security hardening', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.resetModules();
  });

  it('formatSdkArgs redacts sensitive object fields before stringifying', async () => {
    const { createSdkLoggerAdapter } = await import('./logger.js');
    const lines: string[] = [];
    const fakeLogger = {
      child: () => ({
        error: (msg: string) => lines.push(msg),
        warn: (msg: string) => lines.push(msg),
        info: (msg: string) => lines.push(msg),
        debug: (msg: string) => lines.push(msg),
        trace: (msg: string) => lines.push(msg),
      }),
    } as unknown as import('pino').Logger;

    const sdkLog = createSdkLoggerAdapter(fakeLogger);
    sdkLog.error({
      message: 'request failed',
      config: { headers: { Authorization: 'Bearer secret-value' }, data: { app_secret: 'shh' } },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret-value');
    expect(lines[0]).not.toContain('shh');
    expect(lines[0]).toContain('[REDACTED]');
  });

  it('ensureLogFileMode fixes an existing world-readable log file to 0600', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lwa-logger-'));
    const target = join(dir, '2026-01-01.log');
    writeFileSync(target, '{}\n');
    chmodSync(target, 0o644);
    expect(statSync(target).mode & 0o777).toBe(0o644);

    const { ensureLogFileMode } = await import('./logger.js');
    ensureLogFileMode(target);

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('ensureLogFileMode creates a missing log file with 0600', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lwa-logger-'));
    const target = join(dir, '2026-01-02.log');
    const { ensureLogFileMode } = await import('./logger.js');
    ensureLogFileMode(target);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('TTY 模式下的日志输出会经过 process.stdout.write（能被 docked CLI 的 stdout hook 拦截）', async () => {
    // 回归测试：pino 默认的 transport（worker 线程）/ pino-pretty 默认
    // destination（SonicBoom 直写 fd=1）都会绕过 process.stdout.write，
    // 导致 docked 模式下的 ShellScreen.installStdoutHook() 拦不住这些日志，
    // 原始堆栈会直接穿透打到物理终端，破坏固定分区布局。
    // getLogger() 必须用同步 stream + 自定义 destination（内部动态调用
    // process.stdout.write）才能让日志正确纳入 hook 的内容管理系统。
    const isTtyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const prevLevel = process.env['LARK_KIRO_LOG_LEVEL'];
    process.env['LARK_KIRO_LOG_LEVEL'] = 'error';

    const original = process.stdout.write.bind(process.stdout);
    const captured: string[] = [];
    process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
      captured.push(String(chunk));
      if (typeof encoding === 'function') (encoding as () => void)();
      else if (typeof cb === 'function') (cb as () => void)();
      return true;
    }) as typeof process.stdout.write;

    try {
      const { getLogger } = await import('./logger.js');
      const log = getLogger().child({ module: 'agent-runner' });
      log.error({ err: new Error('模拟ACP错误') }, 'agent turn failed');
      // pino 的同步 stream 仍是异步 flush 到底层 stream，等一个 tick。
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.stdout.write = original;
      if (isTtyDescriptor) Object.defineProperty(process.stdout, 'isTTY', isTtyDescriptor);
      if (prevLevel === undefined) delete process.env['LARK_KIRO_LOG_LEVEL'];
      else process.env['LARK_KIRO_LOG_LEVEL'] = prevLevel;
    }

    expect(captured.length).toBeGreaterThan(0);
    expect(captured.join('')).toContain('agent turn failed');
  });
});
