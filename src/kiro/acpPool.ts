/**
 * ACP 进程池：per-chat 常驻 AcpClient，多轮对话复用同一子进程。
 *
 * 设计：
 *   - 每个 chatId 一个 AcpClient 实例（lazy 创建，首次消息时 spawn + initialize）
 *   - 同一 client 内多轮 prompt 天然复用 session（省去 spawn/initialize/load 的 3-4s 开销）
 *   - 空闲超过 idleMs 无新消息 → 自动 close 回收
 *   - 进程崩溃/EOF → 下次 acquire 时自动重建
 *   - /new 或 /cd 时可主动 evict
 *   - SIGTERM 时 closeAll()
 */
import { getLogger } from '../lib/logger.js';
import { AcpClient, type AcpClientConfig } from './acp/client.js';

const log = () => getLogger().child({ module: 'acp-pool' });

export interface AcpPoolConfig {
  /** AcpClient 启动配置（binPath / model / env 等） */
  clientConfig: Omit<AcpClientConfig, 'cwd'>;
  /** 空闲多久后回收进程（ms），默认 10 分钟 */
  idleMs?: number;
}

interface PoolEntry {
  client: AcpClient;
  /** 当前 client 绑定的 sessionId（prompt 复用） */
  sessionId: string | undefined;
  /** 当前 session 的 cwd（切目录时需要重建 session） */
  sessionCwd: string | undefined;
  /** 空闲回收定时器；只在 leaseCount === 0 时才应处于运行状态 */
  idleTimer: NodeJS.Timeout | null;
  /** client 是否已关闭/崩溃 */
  dead: boolean;
  /** 当前正在使用该 entry 的 turn 数（acquire 时 +1，release 时 -1）。
   *  >0 期间禁止空闲回收，防止长任务运行中被误杀。 */
  leaseCount: number;
}

export class AcpPool {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly clientConfig: Omit<AcpClientConfig, 'cwd'>;
  private readonly idleMs: number;

  constructor(config: AcpPoolConfig) {
    this.clientConfig = config.clientConfig;
    this.idleMs = config.idleMs ?? 10 * 60 * 1000;
  }

  /**
   * 获取某 chat 的就绪 AcpClient + sessionId。
   * - 无进程 → spawn + initialize + session/new 或 session/load
   * - 有进程但 cwd 变了 → 在同一进程上 session/new（不杀进程）
   * - 有进程且 cwd 不变 → 直接复用（0 开销）
   *
   * 返回 { client, sessionId }，调用方直接 prompt。
   */
  async acquire(
    chatId: string,
    opts: { cwd: string; resumeId?: string },
  ): Promise<{ client: AcpClient; sessionId: string }> {
    let entry = this.pool.get(chatId);

    // 进程已死或不存在 → 新建
    if (!entry || entry.dead) {
      entry = await this.createEntry(chatId, opts);
      this.acquireLease(entry);
      return { client: entry.client, sessionId: entry.sessionId! };
    }

    // 进程存活但 cwd 变了(用户 /cd) → 在同一进程上开新 session
    if (entry.sessionCwd !== opts.cwd) {
      log().info(
        { chatId, oldCwd: entry.sessionCwd, newCwd: opts.cwd },
        'cwd changed, new session on same process',
      );
      try {
        const sid = await entry.client.newSession(opts.cwd);
        entry.sessionId = sid;
        entry.sessionCwd = opts.cwd;
      } catch (e) {
        // newSession 失败(可能进程已死) → 重建
        log().warn({ err: e, chatId }, 'newSession on existing client failed; recreating');
        await this.destroyEntry(chatId, entry);
        entry = await this.createEntry(chatId, opts);
      }
      this.acquireLease(entry);
      return { client: entry.client, sessionId: entry.sessionId! };
    }

    // 进程存活且 cwd 一致 → 直接复用(0 开销 🚀)
    this.acquireLease(entry);
    return { client: entry.client, sessionId: entry.sessionId! };
  }

  /**
   * 建立一次 lease：leaseCount+1 并取消空闲计时器。
   * turn 运行期间（leaseCount>0）绝不允许空闲回收误杀正在工作的进程。
   */
  private acquireLease(entry: PoolEntry): void {
    entry.leaseCount += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

  /** turn 结束后归还：leaseCount-1；只有归零（无其他并发 turn）才重启空闲计时器。 */
  release(chatId: string): void {
    const entry = this.pool.get(chatId);
    if (!entry) return;
    entry.leaseCount = Math.max(0, entry.leaseCount - 1);
    if (entry.leaseCount === 0) this.resetIdleTimer(chatId, entry);
  }

  /** 更新 entry 的 sessionId（turn 成功后如果 sessionId 变了）。 */
  updateSessionId(chatId: string, sessionId: string): void {
    const entry = this.pool.get(chatId);
    if (entry) entry.sessionId = sessionId;
  }

  /** 主动驱逐（/new 命令清会话时调用）。 */
  async evict(chatId: string): Promise<void> {
    const entry = this.pool.get(chatId);
    if (entry) await this.destroyEntry(chatId, entry);
  }

  /** 关闭所有进程（shutdown）。 */
  async closeAll(): Promise<void> {
    const entries = [...this.pool.entries()];
    this.pool.clear();
    await Promise.all(
      entries.map(async ([, entry]) => {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        try {
          await entry.client.close();
        } catch {
          // ignore
        }
      }),
    );
    log().info({ closed: entries.length }, 'pool closed all');
  }

  // ----- internal -----

  private async createEntry(
    chatId: string,
    opts: { cwd: string; resumeId?: string },
  ): Promise<PoolEntry> {
    const client = AcpClient.spawn({ ...this.clientConfig, cwd: opts.cwd });
    let sessionId: string | undefined;

    try {
      await client.initialize();
      if (opts.resumeId) {
        try {
          await client.loadSession(opts.resumeId, opts.cwd);
          sessionId = opts.resumeId;
        } catch (e) {
          log().warn({ err: e, chatId, resumeId: opts.resumeId }, 'loadSession failed; newSession');
          sessionId = await client.newSession(opts.cwd);
        }
      } else {
        sessionId = await client.newSession(opts.cwd);
      }
    } catch (e) {
      // 创建失败：关闭子进程，抛给上层走 error 终态
      await client.close().catch(() => undefined);
      throw e;
    }

    const entry: PoolEntry = {
      client,
      sessionId,
      sessionCwd: opts.cwd,
      idleTimer: null,
      dead: false,
      leaseCount: 0,
    };
    this.pool.set(chatId, entry);
    log().info({ chatId, sessionId, cwd: opts.cwd }, 'pool entry created');
    return entry;
  }

  private async destroyEntry(chatId: string, entry: PoolEntry): Promise<void> {
    entry.dead = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    this.pool.delete(chatId);
    try {
      await entry.client.close();
    } catch {
      // ignore
    }
    log().debug({ chatId }, 'pool entry destroyed');
  }

  private resetIdleTimer(chatId: string, entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.leaseCount > 0) {
      // 仍有 turn 在跑：不启动计时器，回收判断留给下一次 leaseCount 归零时的 release。
      entry.idleTimer = null;
      return;
    }
    entry.idleTimer = setTimeout(() => {
      if (entry.leaseCount > 0) return; // 双重保险：定时器触发时若已被重新 lease，放弃回收
      log().info({ chatId }, 'idle timeout; recycling acp process');
      void this.destroyEntry(chatId, entry);
    }, this.idleMs);
    // 不阻止进程退出
    if (typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();
  }
}
