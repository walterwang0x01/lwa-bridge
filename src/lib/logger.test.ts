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
});
