/**
 * 进行中卡片注册表（持久化）
 *
 * 解决的问题：
 *   bridge 进程被 SIGTERM / 崩溃 / launchd 重启时，飞书侧的"⏳ 思考中"卡片
 *   没有被 finalize，永远停在 loading 状态。重启后用户点终止按钮也无效，
 *   因为新进程的 ChatPipeline 是空的，找不到对应任务。
 *
 * 设计：
 *   - 每次任务 open() 完成、拿到 messageId 后写入一条记录
 *   - 任务正常 finalize 后删除该条记录
 *   - bootstrap 启动时扫描遗留记录，逐条 patchCard 改成"已中断"，再清空
 *
 * 数据模型：
 *   {
 *     "<conversationId>:<messageId>": { chatId, messageId, taskId, startedAt, replyToMessageId? }
 *   }
 *
 * 文件锁：proper-lockfile，跟 sessions/cron 一致的并发模式。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { ACTIVE_CARDS_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const ActiveCardSchema = z.object({
  chatId: z.string(),
  messageId: z.string(),
  taskId: z.string(),
  startedAt: z.number().int().nonnegative(),
  /** 用户原消息 id，便于 patch 时构造 reply（飞书的 patch 不强依赖，留作 debug） */
  replyToMessageId: z.string().optional(),
});

const FileSchema = z.object({
  version: z.literal(1).default(1),
  cards: z.record(z.string(), ActiveCardSchema).default({}),
});

export type ActiveCard = z.infer<typeof ActiveCardSchema>;
type FileShape = z.infer<typeof FileSchema>;

const log = () => getLogger().child({ module: 'active-cards' });

function readFile(): FileShape {
  if (!existsSync(ACTIVE_CARDS_FILE)) {
    return FileSchema.parse({});
  }
  try {
    const raw = readFileSync(ACTIVE_CARDS_FILE, 'utf-8');
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'active-cards.json validation failed, resetting');
      return FileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'active-cards.json read failed, resetting');
    return FileSchema.parse({});
  }
}

function writeFile(data: FileShape): void {
  ensureDataDirs();
  writeFileSync(ACTIVE_CARDS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(ACTIVE_CARDS_FILE)) {
    writeFileSync(ACTIVE_CARDS_FILE, '{}\n', { mode: 0o600 });
  }
  const release = await lockfile.lock(ACTIVE_CARDS_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

function key(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`;
}

export class ActiveCardsStore {
  /** 注册一张刚 open 的卡片。 */
  async add(card: ActiveCard): Promise<void> {
    await withLock(() => {
      const data = readFile();
      data.cards[key(card.chatId, card.messageId)] = card;
      writeFile(data);
    });
  }

  /** 任务正常完成时删除。chatId+messageId 不在表里也不抛错（幂等）。 */
  async remove(chatId: string, messageId: string): Promise<void> {
    await withLock(() => {
      const data = readFile();
      const k = key(chatId, messageId);
      if (data.cards[k]) {
        delete data.cards[k];
        writeFile(data);
      }
    });
  }

  async removeConversation(conversationId: string, messageId: string): Promise<void> {
    await this.remove(conversationId, messageId);
  }

  /** 列出所有遗留卡片（bootstrap 启动时扫描用）。 */
  async list(): Promise<ActiveCard[]> {
    return await withLock(() => {
      const data = readFile();
      return Object.values(data.cards);
    });
  }

  /** 单点查询（dispatcher 处理 /stop 时用）。 */
  async get(chatId: string, messageId: string): Promise<ActiveCard | undefined> {
    return await withLock(() => {
      const data = readFile();
      return data.cards[key(chatId, messageId)];
    });
  }

  async getConversation(
    conversationId: string,
    messageId: string,
  ): Promise<ActiveCard | undefined> {
    return this.get(conversationId, messageId);
  }

  /** 一次性清空（启动时遗留卡片处理完后调用）。 */
  async clear(): Promise<void> {
    await withLock(() => {
      writeFile(FileSchema.parse({}));
    });
  }
}
