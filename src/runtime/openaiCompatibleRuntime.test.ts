import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, ensureDataDirs } from '../lib/paths.js';
import { OpenAICompatibleRuntime } from './openaiCompatibleRuntime.js';
import type { RuntimeProfile } from './types.js';

const SESSIONS_FILE = join(DATA_DIR, 'openai-sessions.json');

const profile: RuntimeProfile = {
  kind: 'openai-compatible',
  bin: 'openai-compatible',
  model: 'aws-bedrock/claude-haiku-4-5',
  apiBase: 'https://llm-gw.agenzo.com/v1',
  apiKey: 'test-key',
};

describe('OpenAICompatibleRuntime', () => {
  beforeEach(() => {
    ensureDataDirs();
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    try {
      unlinkSync(SESSIONS_FILE);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    try {
      unlinkSync(SESSIONS_FILE);
    } catch {
      // ignore
    }
  });

  it('exposes openai-compatible kind and non-streaming capabilities', () => {
    const rt = new OpenAICompatibleRuntime(profile, { cwd: process.cwd() });
    expect(rt.kind).toBe('openai-compatible');
    expect(rt.capabilities.streaming).toBe(false);
    expect(rt.capabilities.sessionResume).toBe(true);
  });

  it('sends chat completion request and emits message + turn_end', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hello from gateway' } }],
        usage: { total_tokens: 12 },
      }),
    } as Response);

    const rt = new OpenAICompatibleRuntime(profile, { cwd: process.cwd() });
    const sessionId = await rt.newSession(process.cwd());
    const events = [];
    for await (const ev of rt.prompt(sessionId, 'say hello')) {
      events.push(ev);
    }

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(events.map((ev) => ev.kind)).toEqual(['message', 'metadata', 'turn_end']);
    expect(events[0]).toMatchObject({ kind: 'message', text: 'hello from gateway' });
  });

  it('resumes prior session history on next turn', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'first answer' } }] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'second answer' } }] }),
      } as Response);

    const rt = new OpenAICompatibleRuntime(profile, { cwd: process.cwd() });
    const sessionId = await rt.newSession(process.cwd());
    for await (const _ of rt.prompt(sessionId, 'first question')) {
      // drain
    }

    const rt2 = new OpenAICompatibleRuntime(profile, { cwd: process.cwd() });
    await rt2.loadSession(sessionId, process.cwd());
    for await (const _ of rt2.prompt(sessionId, 'second question')) {
      // drain
    }

    const secondCall = vi.mocked(fetch).mock.calls[1];
    const body = JSON.parse(String(secondCall?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.map((m) => m.content)).toEqual([
      'first question',
      'first answer',
      'second question',
    ]);
  });
});
