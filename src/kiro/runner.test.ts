/**
 * runKiro 行为测试（mock AcpClient，不依赖真 Kiro）
 *
 * 重点：resumeId 存在但 loadSession 失败时，降级到 newSession 并仍能跑完 turn，
 * newSessionId 用 ACP 新建的 sessionId 回填，message 文本累积进 result.text。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from './acp/messages.js';

const h = vi.hoisted(() => ({
  loadSession: vi.fn<(id: string, cwd: string) => Promise<void>>(),
  newSession: vi.fn<(cwd: string) => Promise<string>>(),
  cancel: vi.fn<() => Promise<void>>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock('./acp/client.js', () => {
  class FakeAcpClient {
    static spawn() {
      return new FakeAcpClient();
    }
    async initialize() {
      return {};
    }
    loadSession(id: string, cwd: string) {
      return h.loadSession(id, cwd);
    }
    newSession(cwd: string) {
      return h.newSession(cwd);
    }
    async *prompt(sessionId: string): AsyncGenerator<SessionEvent> {
      yield { kind: 'message', sessionId, text: 'Hello ' };
      yield { kind: 'message', sessionId, text: 'world' };
      yield { kind: 'turn_end', sessionId, stopReason: 'end_turn' };
    }
    cancel() {
      return h.cancel();
    }
    close() {
      return h.close();
    }
    get availableSkills() {
      return [];
    }
    get availableTools() {
      return [];
    }
  }
  return { AcpClient: FakeAcpClient };
});

import { runKiro } from './runner.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('runKiro session 续接降级', () => {
  it('loadSession 失败 → 降级 newSession 且跑完 turn', async () => {
    h.loadSession.mockRejectedValueOnce(new Error('session not found'));
    h.newSession.mockResolvedValueOnce('sess_new');

    const events: SessionEvent[] = [];
    const result = await runKiro({
      prompt: 'hi',
      cwd: '/tmp/proj',
      resumeId: 'sess_old',
      onEvent: (ev) => events.push(ev),
    });

    expect(h.loadSession).toHaveBeenCalledWith('sess_old', '/tmp/proj');
    expect(h.newSession).toHaveBeenCalledWith('/tmp/proj');
    expect(result.text).toBe('Hello world');
    expect(result.newSessionId).toBe('sess_new');
    expect(result.exitCode).toBe(0);
    expect(result.aborted).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.idleTimedOut).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(['message', 'message', 'turn_end']);
    expect(h.close).toHaveBeenCalled();
  });

  it('loadSession 成功 → 复用 resumeId，不调 newSession', async () => {
    h.loadSession.mockResolvedValueOnce(undefined);

    const result = await runKiro({
      prompt: 'hi',
      cwd: '/tmp/proj',
      resumeId: 'sess_old',
    });

    expect(h.loadSession).toHaveBeenCalledWith('sess_old', '/tmp/proj');
    expect(h.newSession).not.toHaveBeenCalled();
    expect(result.newSessionId).toBe('sess_old');
    expect(result.exitCode).toBe(0);
  });

  it('无 resumeId → 直接 newSession', async () => {
    h.newSession.mockResolvedValueOnce('sess_fresh');

    const result = await runKiro({ prompt: 'hi', cwd: '/tmp/proj' });

    expect(h.loadSession).not.toHaveBeenCalled();
    expect(h.newSession).toHaveBeenCalledWith('/tmp/proj');
    expect(result.newSessionId).toBe('sess_fresh');
  });
});
