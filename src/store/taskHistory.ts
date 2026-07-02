/**
 * 任务历史记录（只读展示用，Dashboard「任务历史」面板的数据源）
 *
 * 记录每次 Kiro 任务的终态摘要：跑了哪些工具、产出了哪些文件、耗时多久。
 * 不记录完整回复文本（可能很长且含敏感信息），只记录摘要。
 *
 * 容量控制：只保留最近 MAX_RECORDS 条（环形覆盖），避免文件无限增长。
 * 文件锁：proper-lockfile，跟 activeCards/sessions 一致的并发模式。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { TASK_HISTORY_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'task-history' });

const MAX_RECORDS = 200;

const TaskHistoryRecordSchema = z.object({
  taskId: z.string(),
  chatId: z.string(),
  cwd: z.string(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  /** 与 RunState.terminal 对齐（done/error/interrupted/idle_timeout/timeout） */
  terminal: z.string(),
  /** 用户 prompt 前 100 字符，脱敏展示用 */
  promptPreview: z.string(),
  toolCallCount: z.number().int().nonnegative(),
  /** 本次任务写入/编辑过的文件路径（去重），从 fs_write/fsWrite 等工具的 input.path 提取 */
  artifacts: z.array(z.string()).default([]),
  errorMsg: z.string().optional(),
});

export type TaskHistoryRecord = z.infer<typeof TaskHistoryRecordSchema>;

const FileSchema = z.object({
  version: z.literal(1).default(1),
  records: z.array(TaskHistoryRecordSchema).default([]),
});

type FileShape = z.infer<typeof FileSchema>;

function readFile(): FileShape {
  if (!existsSync(TASK_HISTORY_FILE)) return FileSchema.parse({});
  try {
    const raw = readFileSync(TASK_HISTORY_FILE, 'utf-8');
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'task-history.json validation failed, resetting');
      return FileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'task-history.json read failed, resetting');
    return FileSchema.parse({});
  }
}

function writeFile(data: FileShape): void {
  ensureDataDirs();
  writeFileSync(TASK_HISTORY_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(TASK_HISTORY_FILE)) writeFileSync(TASK_HISTORY_FILE, '{}\n', { mode: 0o600 });
  const release = await lockfile.lock(TASK_HISTORY_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

export class TaskHistoryStore {
  /** 追加一条记录；超过 MAX_RECORDS 时丢弃最旧的（环形覆盖）。 */
  async add(record: TaskHistoryRecord): Promise<void> {
    await withLock(() => {
      const data = readFile();
      data.records.push(record);
      if (data.records.length > MAX_RECORDS) {
        data.records.splice(0, data.records.length - MAX_RECORDS);
      }
      writeFile(data);
    });
  }

  /** 列出最近的记录，按时间倒序（最新在前）。limit 默认 50。 */
  async listRecent(limit = 50): Promise<TaskHistoryRecord[]> {
    return withLock(() => {
      const data = readFile();
      return [...data.records].reverse().slice(0, limit);
    });
  }
}
