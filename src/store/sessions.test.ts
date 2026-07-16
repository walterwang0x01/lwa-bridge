// SessionStore unit tests covering create-on-first-get, cwd switching, kiro session
// linking per (chat, cwd), idle timeout overrides, and concurrent withLock writes.
//
// Strategy: we mock '../lib/paths.js' to redirect SESSIONS_FILE into a per-suite
// temp directory so tests do not touch the real ~/.lark-kiro-bridge/.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Allocate a unique temp dir for the entire suite, then override the paths module
// so SessionStore writes there instead of the user's home.
const tmpRoot = mkdtempSync(join(tmpdir(), 'lkb-sessions-test-'));
const tmpSessionsFile = join(tmpRoot, 'sessions.json');
const tmpLogsDir = join(tmpRoot, 'logs');
const tmpMediaDir = join(tmpRoot, 'media');

vi.mock('../lib/paths.js', () => ({
  DATA_DIR: tmpRoot,
  LOGS_DIR: tmpLogsDir,
  MEDIA_DIR: tmpMediaDir,
  CONFIG_FILE: join(tmpRoot, 'config.json'),
  SESSIONS_FILE: tmpSessionsFile,
  WORKSPACES_FILE: join(tmpRoot, 'workspaces.json'),
  PROCESSES_FILE: join(tmpRoot, 'processes.json'),
  ensureDataDirs: () => {
    // mkdir -p the temp dirs (sync)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { mkdirSync } = require('node:fs');
    mkdirSync(tmpRoot, { recursive: true, mode: 0o700 });
    mkdirSync(tmpLogsDir, { recursive: true, mode: 0o700 });
    mkdirSync(tmpMediaDir, { recursive: true, mode: 0o700 });
  },
}));

// Import after mock so SessionStore sees the redirected paths.
const { SessionStore } = await import('./sessions.js');

describe('SessionStore', () => {
  let store: InstanceType<typeof SessionStore>;

  beforeEach(() => {
    // Each test starts from a clean sessions.json
    if (existsSync(tmpSessionsFile)) rmSync(tmpSessionsFile);
    store = new SessionStore();
  });

  afterEach(() => {
    if (existsSync(tmpSessionsFile)) rmSync(tmpSessionsFile);
  });

  describe('get', () => {
    it('creates a new session on first call with the default cwd', async () => {
      const session = await store.get('chat_1', '/default/cwd');
      expect(session.currentCwd).toBe('/default/cwd');
      expect(session.sessionsByCwd).toEqual({});
      expect(session.lastActiveAt).toBeGreaterThan(0);
    });

    it('returns the same data on subsequent calls for the same chat', async () => {
      const a = await store.get('chat_1', '/default');
      const b = await store.get('chat_1', '/another'); // defaultCwd ignored when session exists
      expect(b.currentCwd).toBe(a.currentCwd);
      expect(b.currentCwd).toBe('/default');
    });

    it('isolates state across different chatIds', async () => {
      await store.get('chat_a', '/aaa');
      await store.get('chat_b', '/bbb');
      const a = await store.get('chat_a', '/x');
      const b = await store.get('chat_b', '/x');
      expect(a.currentCwd).toBe('/aaa');
      expect(b.currentCwd).toBe('/bbb');
    });

    it('persists to disk', async () => {
      await store.get('chat_1', '/default');
      expect(existsSync(tmpSessionsFile)).toBe(true);
      const raw = JSON.parse(readFileSync(tmpSessionsFile, 'utf-8'));
      expect(raw.chats.chat_1.currentCwd).toBe('/default');
    });
  });

  describe('setCwd', () => {
    it('updates currentCwd for an existing chat', async () => {
      await store.get('chat_1', '/orig');
      const updated = await store.setCwd('chat_1', '/new', '/default');
      expect(updated.currentCwd).toBe('/new');
    });

    it('creates the session if missing', async () => {
      const updated = await store.setCwd('chat_2', '/new', '/default');
      expect(updated.currentCwd).toBe('/new');
      expect(updated.sessionsByCwd).toEqual({});
    });

    it('preserves sessionsByCwd across cwd switches', async () => {
      await store.get('chat_1', '/a');
      await store.setKiroSession('chat_1', '/a', 'sid-a');
      await store.setCwd('chat_1', '/b', '/default');
      await store.setKiroSession('chat_1', '/b', 'sid-b');
      // Switch back to /a — kiro session for /a should still be there
      const back = await store.setCwd('chat_1', '/a', '/default');
      expect(back.sessionsByCwd).toEqual({ '/a': 'sid-a', '/b': 'sid-b' });
    });
  });

  describe('setKiroSession / getKiroSession / clearKiroSession', () => {
    it('round-trips a kiro session id', async () => {
      await store.get('chat_1', '/a');
      await store.setKiroSession('chat_1', '/a', 'kiro-sess-aaa');
      expect(await store.getKiroSession('chat_1', '/a')).toBe('kiro-sess-aaa');
    });

    it('returns undefined when no session linked', async () => {
      await store.get('chat_1', '/a');
      expect(await store.getKiroSession('chat_1', '/missing')).toBeUndefined();
    });

    it('returns undefined for unknown chat', async () => {
      expect(await store.getKiroSession('nonexistent', '/x')).toBeUndefined();
    });

    it('clearKiroSession removes only the targeted cwd entry', async () => {
      await store.get('chat_1', '/a');
      await store.setKiroSession('chat_1', '/a', 'sid-a');
      await store.setKiroSession('chat_1', '/b', 'sid-b');
      await store.clearKiroSession('chat_1', '/a');
      expect(await store.getKiroSession('chat_1', '/a')).toBeUndefined();
      expect(await store.getKiroSession('chat_1', '/b')).toBe('sid-b');
    });

    it('clearKiroSession on missing chat is a no-op', async () => {
      // Should not throw
      await store.clearKiroSession('nonexistent', '/x');
    });

    it('setKiroSession on missing chat is a no-op (no session created)', async () => {
      // setKiroSession requires the chat session to exist already
      await store.setKiroSession('nonexistent', '/x', 'sid');
      expect(await store.getKiroSession('nonexistent', '/x')).toBeUndefined();
    });
  });

  describe('setIdleTimeout', () => {
    it('sets a positive minutes value', async () => {
      await store.setIdleTimeout('chat_1', 10, '/default');
      const s = await store.get('chat_1', '/default');
      expect(s.idleTimeoutMinutes).toBe(10);
    });

    it('sets 0 to mean explicitly disabled', async () => {
      await store.setIdleTimeout('chat_1', 0, '/default');
      const s = await store.get('chat_1', '/default');
      expect(s.idleTimeoutMinutes).toBe(0);
    });

    it('undefined clears the override', async () => {
      await store.setIdleTimeout('chat_1', 10, '/default');
      await store.setIdleTimeout('chat_1', undefined, '/default');
      const s = await store.get('chat_1', '/default');
      expect(s.idleTimeoutMinutes).toBeUndefined();
    });

    it('creates the chat session if missing', async () => {
      await store.setIdleTimeout('chat_new', 5, '/default-cwd');
      const s = await store.get('chat_new', '/another');
      expect(s.currentCwd).toBe('/default-cwd');
      expect(s.idleTimeoutMinutes).toBe(5);
    });
  });

  describe('concurrent writes (file lock)', () => {
    it('parallel setKiroSession on different cwds do not lose data', async () => {
      await store.get('chat_1', '/init');
      await Promise.all([
        store.setKiroSession('chat_1', '/p1', 'sid-1'),
        store.setKiroSession('chat_1', '/p2', 'sid-2'),
        store.setKiroSession('chat_1', '/p3', 'sid-3'),
        store.setKiroSession('chat_1', '/p4', 'sid-4'),
        store.setKiroSession('chat_1', '/p5', 'sid-5'),
      ]);
      expect(await store.getKiroSession('chat_1', '/p1')).toBe('sid-1');
      expect(await store.getKiroSession('chat_1', '/p2')).toBe('sid-2');
      expect(await store.getKiroSession('chat_1', '/p3')).toBe('sid-3');
      expect(await store.getKiroSession('chat_1', '/p4')).toBe('sid-4');
      expect(await store.getKiroSession('chat_1', '/p5')).toBe('sid-5');
    });

    it('parallel setCwd preserves the latest write', async () => {
      // All writes to the same field — last-write-wins is acceptable as long as
      // the file is not corrupted. This test asserts no corruption + a valid value.
      await store.get('chat_1', '/init');
      await Promise.all([
        store.setCwd('chat_1', '/a', '/default'),
        store.setCwd('chat_1', '/b', '/default'),
        store.setCwd('chat_1', '/c', '/default'),
      ]);
      const final = await store.get('chat_1', '/default');
      expect(['/a', '/b', '/c']).toContain(final.currentCwd);
    });
  });

  describe('persistence and recovery', () => {
    it('reads back across SessionStore instances', async () => {
      await store.get('chat_1', '/a');
      await store.setKiroSession('chat_1', '/a', 'sid');
      const store2 = new SessionStore();
      const reloaded = await store2.get('chat_1', '/x');
      expect(reloaded.currentCwd).toBe('/a');
      expect(reloaded.sessionsByCwd).toEqual({ '/a': 'sid' });
    });

    it('recovers from a corrupted sessions.json by resetting', async () => {
      // First put valid data, then corrupt the file
      await store.get('chat_1', '/a');
      // Overwrite with invalid JSON
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { writeFileSync } = require('node:fs');
      writeFileSync(tmpSessionsFile, 'not valid json{');
      // Should not throw, just return a fresh state on the next read
      const next = await store.get('chat_2', '/fresh');
      expect(next.currentCwd).toBe('/fresh');
    });

    it('handles a missing sessions.json on first access', async () => {
      // Already covered indirectly by beforeEach's rmSync, but explicit:
      if (existsSync(tmpSessionsFile)) rmSync(tmpSessionsFile);
      const s = await store.get('fresh_chat', '/cwd');
      expect(s.currentCwd).toBe('/cwd');
    });
  });

  describe('clearConversationRuntimeProfile', () => {
    it('clears the sticky profile AND the last-used engine cache (Auto status bar bug)', async () => {
      // 模拟：先手动选了一个引擎并跑完一轮 turn（写入 lastUsedRuntimeProfile/lastUsedModel）
      await store.get('chat_1', '/proj');
      await store.setConversationRuntimeProfile('chat_1', 'openai-strong', '/proj');
      await store.setLastUsedRuntime('chat_1', 'openai-strong', 'claude-opus-4-8', '/proj');

      let session = await store.get('chat_1', '/proj');
      expect(session.runtimeProfile).toBe('openai-strong');
      expect(session.lastUsedRuntimeProfile).toBe('openai-strong');
      expect(session.lastUsedModel).toBe('claude-opus-4-8');

      // 用户切回 Auto：粘性 profile 和缓存的旧引擎名都应被清掉，
      // 否则状态栏会在下一条消息真正跑完之前继续显示旧引擎（Auto→openai-strong）。
      await store.clearConversationRuntimeProfile('chat_1');

      session = await store.get('chat_1', '/proj');
      expect(session.runtimeProfile).toBeUndefined();
      expect(session.lastUsedRuntimeProfile).toBeUndefined();
      expect(session.lastUsedModel).toBeUndefined();
    });

    it('is a no-op for a chat that has never been seen', async () => {
      await expect(store.clearConversationRuntimeProfile('never_seen')).resolves.toBeUndefined();
    });
  });
});
