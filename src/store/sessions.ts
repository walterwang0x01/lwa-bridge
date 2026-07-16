/**
 * 会话状态持久化
 *
 * 数据模型：
 *   每个会话 conversationId（飞书里等价于 chatId）维护一个 ChatSession：
 *     - currentCwd: 当前工作目录
 *     - sessionsByCwd: cwd → kiroSessionId 的映射
 *
 * 切换工作目录时，该会话之前在新 cwd 下的 kiroSessionId 会被自动恢复（如果有），
 * 否则下次跑 Kiro 时新建。
 *
 * 这是工作目录方案 B 的核心数据结构。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { SESSIONS_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const ChatSessionSchema = z.object({
  currentCwd: z.string(),
  sessionsByCwd: z.record(z.string(), z.string()).default({}),
  /** per-chat 选用的 runtime profile 名（config.runtime.profiles 的 key） */
  runtimeProfile: z.string().optional(),
  lastActiveAt: z.number().int().nonnegative().default(0),
  /**
   * per-chat idle watchdog 分钟数覆盖：
   *   undefined → 用全局默认（preferences/kiro.idleTimeoutMinutes）
   *   0         → 显式关闭
   *   N>0       → 用 N 分钟
   */
  idleTimeoutMinutes: z.number().int().nonnegative().optional(),
  /** CLI 会话标题（/sessions 展示） */
  title: z.string().optional(),
  /** 阶段：plan / apply / review */
  phase: z.enum(['plan', 'apply', 'review']).optional(),
  /** /compact 后的可读摘要，注入后续 turn */
  compactionSummary: z.string().optional(),
  /** 上次 compact 时间（auto-compact 防抖） */
  lastCompactAt: z.number().int().nonnegative().optional(),
  /** 本会话触及的文件路径（compact 后可重读） */
  filesTouched: z.array(z.string()).optional(),
  /** Auto 模式下上一轮实际使用的 runtime profile */
  lastUsedRuntimeProfile: z.string().optional(),
  lastUsedModel: z.string().optional(),
  /** CLI 工具审批：true=Run Everything，false=Ask each time，undefined=跟 profile.force */
  runEverything: z.boolean().optional(),
  /** runtime 上报的实时上下文占用 %（kiro metadata） */
  liveContextPct: z.number().min(0).max(100).optional(),
});

const SessionsFileSchema = z.object({
  version: z.literal(1).default(1),
  chats: z.record(z.string(), ChatSessionSchema).default({}),
});

export type ChatSession = z.infer<typeof ChatSessionSchema>;
export type SessionsFile = z.infer<typeof SessionsFileSchema>;

const log = () => getLogger().child({ module: 'sessions' });

function readFile(): SessionsFile {
  if (!existsSync(SESSIONS_FILE)) {
    return SessionsFileSchema.parse({});
  }
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf-8');
    const parsed = SessionsFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'sessions.json validation failed, resetting');
      return SessionsFileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'sessions.json read failed, resetting');
    return SessionsFileSchema.parse({});
  }
}

function writeFile(data: SessionsFile): void {
  ensureDataDirs();
  writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * 文件锁包装器：防止多进程并发写入损坏文件。
 * proper-lockfile 用 .lock 目录实现跨进程互斥。
 */
async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  // 文件不存在时先创建空文件，否则 lockfile 会报 ENOENT
  if (!existsSync(SESSIONS_FILE)) {
    writeFileSync(SESSIONS_FILE, '{}\n', { mode: 0o600 });
  }
  const release = await lockfile.lock(SESSIONS_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

export class SessionStore {
  /**
   * 列出所有 chat 的会话状态（只读，给 dashboard 总览用）。
   */
  async listAll(): Promise<Record<string, ChatSession>> {
    return withLock(() => readFile().chats);
  }

  /**
   * 获取一个 chat 的会话状态；不存在则用 defaultCwd 初始化。
   */
  async get(chatId: string, defaultCwd: string): Promise<ChatSession> {
    return withLock(() => {
      const data = readFile();
      let session = data.chats[chatId];
      if (!session) {
        session = {
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        };
        data.chats[chatId] = session;
        writeFile(data);
      }
      return session;
    });
  }

  /** 渠道无关别名：conversationId 在飞书里等价于 chatId。 */
  async getConversation(conversationId: string, defaultCwd: string): Promise<ChatSession> {
    return this.get(conversationId, defaultCwd);
  }

  /**
   * 切换 chat 的当前 cwd。该 cwd 下若已有 kiro session 会被自动延用。
   */
  async setCwd(chatId: string, cwd: string, defaultCwd: string): Promise<ChatSession> {
    return withLock(() => {
      const data = readFile();
      const session = data.chats[chatId] ?? {
        currentCwd: defaultCwd,
        sessionsByCwd: {},
        lastActiveAt: Date.now(),
      };
      session.currentCwd = cwd;
      session.lastActiveAt = Date.now();
      data.chats[chatId] = session;
      writeFile(data);
      return session;
    });
  }

  async setConversationCwd(
    conversationId: string,
    cwd: string,
    defaultCwd: string,
  ): Promise<ChatSession> {
    return this.setCwd(conversationId, cwd, defaultCwd);
  }

  /**
   * 关联当前 (chatId, cwd) 到一个 kiroSessionId（Kiro CLI 跑完返回的 sid）。
   */
  async setKiroSession(chatId: string, cwd: string, kiroSessionId: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session = data.chats[chatId];
      if (!session) return;
      session.sessionsByCwd[cwd] = kiroSessionId;
      session.lastActiveAt = Date.now();
      writeFile(data);
    });
  }

  async setConversationKiroSession(
    conversationId: string,
    cwd: string,
    kiroSessionId: string,
  ): Promise<void> {
    await this.setKiroSession(conversationId, cwd, kiroSessionId);
  }

  /**
   * 清空当前 cwd 下的 kiro session（用于 /new 命令）。
   */
  async clearKiroSession(chatId: string, cwd: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session = data.chats[chatId];
      if (!session) return;
      delete session.sessionsByCwd[cwd];
      session.lastActiveAt = Date.now();
      writeFile(data);
    });
  }

  async clearConversationKiroSession(conversationId: string, cwd: string): Promise<void> {
    await this.clearKiroSession(conversationId, cwd);
  }

  /**
   * 获取当前 (chatId, cwd) 对应的 agent session id（可能不存在）。
   * 存储格式为 `{runtimeKind}:{nativeId}`；legacy 无前缀视为 kiro-cli-acp。
   *
   * @param maxAgeMs 超过此毫秒数未活动则视为过期，返回 undefined（自动开新 session）。
   *   传 0 = 永不过期。undefined = 不做检查（兼容旧调用）。
   */
  async getKiroSession(
    chatId: string,
    cwd: string,
    maxAgeMs?: number,
  ): Promise<string | undefined> {
    return this.getAgentSession(chatId, cwd, maxAgeMs);
  }

  async getAgentSession(
    chatId: string,
    cwd: string,
    maxAgeMs?: number,
  ): Promise<string | undefined> {
    return withLock(() => {
      const data = readFile();
      const session = data.chats[chatId];
      if (!session) return undefined;

      if (maxAgeMs && maxAgeMs > 0 && session.lastActiveAt > 0) {
        const age = Date.now() - session.lastActiveAt;
        if (age > maxAgeMs) {
          log().info(
            {
              chatId,
              cwd,
              ageMin: Math.round(age / 60_000),
              maxAgeMin: Math.round(maxAgeMs / 60_000),
            },
            'session expired by TTL; will start fresh',
          );
          delete session.sessionsByCwd[cwd];
          writeFile(data);
          return undefined;
        }
      }

      return session.sessionsByCwd[cwd];
    });
  }

  async getConversationAgentSession(
    conversationId: string,
    cwd: string,
    maxAgeMs?: number,
  ): Promise<string | undefined> {
    return this.getAgentSession(conversationId, cwd, maxAgeMs);
  }

  async getRuntimeProfile(chatId: string): Promise<string | undefined> {
    return withLock(() => {
      const data = readFile();
      return data.chats[chatId]?.runtimeProfile;
    });
  }

  async getConversationRuntimeProfile(conversationId: string): Promise<string | undefined> {
    return this.getRuntimeProfile(conversationId);
  }

  async setRuntimeProfile(chatId: string, profileName: string, defaultCwd: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session =
        data.chats[chatId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      session.runtimeProfile = profileName;
      session.lastActiveAt = Date.now();
      data.chats[chatId] = session;
      writeFile(data);
    });
  }

  async setConversationRuntimeProfile(
    conversationId: string,
    profileName: string,
    defaultCwd: string,
  ): Promise<void> {
    await this.setRuntimeProfile(conversationId, profileName, defaultCwd);
  }

  /** 清除会话粘性 runtime（恢复 auto 路由）；同时清掉 lastUsedRuntimeProfile 缓存，
   *  避免状态栏在下一条消息真正跑完之前，继续显示切换前的旧引擎名。 */
  async clearConversationRuntimeProfile(conversationId: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session = data.chats[conversationId];
      if (!session) return;
      delete session.runtimeProfile;
      delete session.lastUsedRuntimeProfile;
      delete session.lastUsedModel;
      session.lastActiveAt = Date.now();
      writeFile(data);
    });
  }

  /**
   * 更新 chat 的 lastActiveAt 时间戳（每次成功 turn 后调用）。
   */
  async touch(chatId: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session = data.chats[chatId];
      if (!session) return;
      session.lastActiveAt = Date.now();
      writeFile(data);
    });
  }

  async touchConversation(conversationId: string): Promise<void> {
    await this.touch(conversationId);
  }

  /**
   * 设置 chat 的 idle watchdog 阈值（分钟）。
   *   - undefined：清除覆盖，回归全局默认
   *   - 0：关闭
   *   - N>0：用 N 分钟
   */
  async setIdleTimeout(
    chatId: string,
    minutes: number | undefined,
    defaultCwd: string,
  ): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session =
        data.chats[chatId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      if (minutes === undefined) {
        delete session.idleTimeoutMinutes;
      } else {
        session.idleTimeoutMinutes = minutes;
      }
      session.lastActiveAt = Date.now();
      data.chats[chatId] = session;
      writeFile(data);
    });
  }

  async setConversationIdleTimeout(
    conversationId: string,
    minutes: number | undefined,
    defaultCwd: string,
  ): Promise<void> {
    await this.setIdleTimeout(conversationId, minutes, defaultCwd);
  }

  /** 列出 CLI 会话（conversationId 以 cli- 开头）。 */
  async listCliSessions(): Promise<
    Array<{
      id: string;
      cwd: string;
      title?: string;
      phase?: string;
      runtimeProfile?: string;
      lastActiveAt: number;
      hasSummary: boolean;
    }>
  > {
    return withLock(() => {
      const data = readFile();
      return Object.entries(data.chats)
        .filter(([id]) => id.startsWith('cli-'))
        .map(([id, s]) => ({
          id,
          cwd: s.currentCwd,
          title: s.title,
          phase: s.phase,
          runtimeProfile: s.runtimeProfile,
          lastActiveAt: s.lastActiveAt,
          hasSummary: Boolean(s.compactionSummary),
        }))
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    });
  }

  async setConversationMeta(
    conversationId: string,
    patch: {
      title?: string;
      phase?: 'plan' | 'apply' | 'review' | null;
      compactionSummary?: string | null;
      lastCompactAt?: number | null;
      filesTouched?: string[] | null;
    },
    defaultCwd: string,
  ): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session =
        data.chats[conversationId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      if (patch.title !== undefined) session.title = patch.title;
      if (patch.phase === null) delete session.phase;
      else if (patch.phase !== undefined) session.phase = patch.phase;
      if (patch.compactionSummary === null) delete session.compactionSummary;
      else if (patch.compactionSummary !== undefined) {
        session.compactionSummary = patch.compactionSummary;
      }
      if (patch.lastCompactAt === null) delete session.lastCompactAt;
      else if (patch.lastCompactAt !== undefined) session.lastCompactAt = patch.lastCompactAt;
      if (patch.filesTouched === null) delete session.filesTouched;
      else if (patch.filesTouched !== undefined) session.filesTouched = patch.filesTouched;
      session.lastActiveAt = Date.now();
      data.chats[conversationId] = session;
      writeFile(data);
    });
  }

  async appendFilesTouched(
    conversationId: string,
    paths: string[],
    defaultCwd: string,
    max = 40,
  ): Promise<string[]> {
    return withLock(() => {
      const data = readFile();
      const session =
        data.chats[conversationId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      const seen = new Set(session.filesTouched ?? []);
      const merged = [...(session.filesTouched ?? [])];
      for (const p of paths) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        merged.push(p);
      }
      session.filesTouched = merged.slice(-max);
      session.lastActiveAt = Date.now();
      data.chats[conversationId] = session;
      writeFile(data);
      return session.filesTouched;
    });
  }

  async getFilesTouched(conversationId: string): Promise<string[]> {
    return withLock(() => readFile().chats[conversationId]?.filesTouched ?? []);
  }

  /** 最近一个 CLI 会话 id（按 lastActiveAt）。 */
  async latestCliSessionId(prefix?: string): Promise<string | undefined> {
    const list = await this.listCliSessions();
    const filtered = prefix ? list.filter((s) => s.id.startsWith(prefix)) : list;
    return filtered[0]?.id;
  }

  async getCompactionSummary(conversationId: string): Promise<string | undefined> {
    return withLock(() => readFile().chats[conversationId]?.compactionSummary);
  }

  async getConversationPhase(
    conversationId: string,
  ): Promise<'plan' | 'apply' | 'review' | undefined> {
    return withLock(() => readFile().chats[conversationId]?.phase);
  }

  async setLastUsedRuntime(
    conversationId: string,
    profileName: string,
    model: string | undefined,
    defaultCwd: string,
  ): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session =
        data.chats[conversationId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      session.lastUsedRuntimeProfile = profileName;
      if (model) session.lastUsedModel = model;
      session.lastActiveAt = Date.now();
      data.chats[conversationId] = session;
      writeFile(data);
    });
  }

  async setRunEverything(
    conversationId: string,
    enabled: boolean | undefined,
    defaultCwd: string,
  ): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session =
        data.chats[conversationId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      if (enabled === undefined) delete session.runEverything;
      else session.runEverything = enabled;
      session.lastActiveAt = Date.now();
      data.chats[conversationId] = session;
      writeFile(data);
    });
  }

  async getRunEverything(conversationId: string): Promise<boolean | undefined> {
    return withLock(() => readFile().chats[conversationId]?.runEverything);
  }

  async setLiveContextPct(
    conversationId: string,
    pct: number | undefined,
    defaultCwd: string,
  ): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const session =
        data.chats[conversationId] ??
        ({
          currentCwd: defaultCwd,
          sessionsByCwd: {},
          lastActiveAt: Date.now(),
        } as ChatSession);
      if (pct === undefined) delete session.liveContextPct;
      else session.liveContextPct = Math.min(100, Math.max(0, Math.round(pct)));
      session.lastActiveAt = Date.now();
      data.chats[conversationId] = session;
      writeFile(data);
    });
  }
}
