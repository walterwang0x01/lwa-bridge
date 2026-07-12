import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  buildNativeCodingTarget,
  launchNativeCodingCli,
  supportsNativeCodingHandoff,
} from './nativeCli.js';
import type { RuntimeProfile } from '../../runtime/types.js';

describe('supportsNativeCodingHandoff', () => {
  it('true for kiro and cursor only', () => {
    expect(supportsNativeCodingHandoff('kiro-cli-acp')).toBe(true);
    expect(supportsNativeCodingHandoff('cursor-agent-cli')).toBe(true);
    expect(supportsNativeCodingHandoff('openai-compatible')).toBe(false);
    expect(supportsNativeCodingHandoff('gemini-cli')).toBe(false);
  });
});

describe('buildNativeCodingTarget', () => {
  it('builds kiro-cli chat with model and resume', () => {
    const profile: RuntimeProfile = {
      kind: 'kiro-cli-acp',
      bin: 'kiro-cli',
      model: 'claude-sonnet-4.6',
    };
    const t = buildNativeCodingTarget({ profile, continueSession: true });
    expect(t.bin).toBe('kiro-cli');
    expect(t.args).toEqual(['chat', '--resume', '--model', 'claude-sonnet-4.6']);
    expect(t.label).toContain('kiro-cli chat');
  });

  it('uses resume-id when provided', () => {
    const profile: RuntimeProfile = { kind: 'kiro-cli-acp', bin: 'kiro-cli' };
    const t = buildNativeCodingTarget({ profile, resumeId: 'abc-123' });
    expect(t.args).toContain('--resume-id');
    expect(t.args).toContain('abc-123');
  });

  it('builds agent without --print', () => {
    const profile: RuntimeProfile = {
      kind: 'cursor-agent-cli',
      bin: 'agent',
      model: 'Auto',
    };
    const t = buildNativeCodingTarget({ profile, continueSession: true });
    expect(t.bin).toBe('agent');
    expect(t.args).toEqual(['--continue']);
    expect(t.args).not.toContain('--print');
  });
});

describe('launchNativeCodingCli', () => {
  it('spawns with inherit and resolves exit code', async () => {
    const child = new EventEmitter() as EventEmitter & {
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
    };
    child.killed = false;
    child.kill = vi.fn();
    const spawnImpl = vi.fn().mockReturnValue(child);
    const writes: string[] = [];
    const p = launchNativeCodingCli({
      target: {
        kind: 'kiro-cli-acp',
        bin: 'kiro-cli',
        args: ['chat'],
        label: 'kiro-cli chat',
      },
      cwd: '/tmp/proj',
      spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      write: (s) => writes.push(s),
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      'kiro-cli',
      ['chat'],
      expect.objectContaining({ cwd: '/tmp/proj', stdio: 'inherit' }),
    );
    expect(writes[0]).toContain('kiro-cli chat');
    queueMicrotask(() => child.emit('exit', 0, null));
    await expect(p).resolves.toBe(0);
  });
});
