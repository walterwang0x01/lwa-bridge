import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigSchema } from '../lib/config.js';
import * as registry from './registry.js';
import { runCliDoctor } from './cliDoctor.js';

function makeConfig() {
  return ConfigSchema.parse({
    lark: { appId: 'a', appSecret: 'b' },
    runtime: {
      plan: 'kiro-unlimited+cursor-lite',
      compact: { auto: true, thresholdChars: 80_000 },
    },
  });
}

describe('runCliDoctor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns structured checkup text', async () => {
    vi.spyOn(registry, 'discoverRuntimeRegistry').mockResolvedValue([
      {
        profileName: 'kiro',
        profile: { kind: 'kiro-cli-acp', bin: 'kiro-cli' },
        available: true,
        models: [],
      },
      {
        profileName: 'cursor',
        profile: { kind: 'cursor-agent-cli', bin: 'agent' },
        available: false,
        models: [],
      },
    ]);
    const { lines, text } = await runCliDoctor({
      config: makeConfig(),
      cwd: process.cwd(),
      harnessMode: 'code',
      conversationId: 'cli-code-test',
    });
    expect(lines.some((l) => l.name === 'plan' && l.level === 'ok')).toBe(true);
    expect(lines.find((l) => l.name === 'runtimes')?.detail).toContain('kiro');
    expect(lines.find((l) => l.name === 'runtimes')?.detail).toContain('cursor');
    expect(lines.some((l) => l.name === 'gateway')).toBe(true);
    expect(lines.some((l) => l.name === 'session')).toBe(true);
    expect(text).toContain('LWA doctor');
    expect(text).toContain('cli-code-test');
    expect(text).toMatch(/plan:/);
  });
});
