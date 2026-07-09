import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

vi.mock('node:util', () => ({
  promisify: () => execFileMock,
}));

import { probeNativeCliQuota } from './nativeQuotaProbe.js';

describe('nativeQuotaProbe', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('parses kiro-cli usage --json', async () => {
    execFileMock.mockResolvedValue({
      stdout: JSON.stringify({ remaining: 2, limit: 10 }),
    });
    const result = await probeNativeCliQuota({ kind: 'kiro-cli-acp', bin: 'kiro-cli' });
    expect(result).toEqual({
      state: 'healthy',
      detail: 'kiro-cli usage --json remaining=2/10',
      remainingRatio: 0.2,
    });
    expect(execFileMock).toHaveBeenCalledWith('kiro-cli', ['usage', '--json'], { timeout: 8000 });
  });

  it('skips cursor runtime', async () => {
    const result = await probeNativeCliQuota({
      kind: 'cursor-agent-cli',
      bin: 'agent',
      force: true,
    });
    expect(result).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
