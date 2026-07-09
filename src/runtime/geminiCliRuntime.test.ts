import { describe, expect, it } from 'vitest';
import { GeminiCliRuntime } from './geminiCliRuntime.js';
import type { RuntimeProfile } from './types.js';

const profile: RuntimeProfile = {
  kind: 'gemini-cli',
  bin: 'gemini',
  model: 'auto',
};

describe('GeminiCliRuntime', () => {
  it('exposes gemini-cli kind and streaming capabilities', () => {
    const rt = new GeminiCliRuntime(profile, { cwd: process.cwd() });
    expect(rt.kind).toBe('gemini-cli');
    expect(rt.capabilities.streaming).toBe(true);
    expect(rt.capabilities.acp).toBe(false);
  });

  it('newSession returns empty session id (stateless CLI)', async () => {
    const rt = new GeminiCliRuntime(profile, { cwd: process.cwd() });
    await expect(rt.newSession(process.cwd())).resolves.toBe('');
  });
});
