/**
 * 进程注册表
 *
 * 每个跑着的 bridge 进程在启动时往 ~/.lark-kiro-bridge/processes.json 里注册一条，
 * 退出时自删。供 `ps`、`kill`、以及 `run` 启动时检测同 app 多实例使用。
 *
 * 同一个飞书 app 同时跑两个 bridge 进程时，飞书 WS 事件会被随机路由到其中一个，
 * 表现就是"机器人有时回复有时不回复"——所以启动时要主动检测。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { PROCESSES_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const ProcessEntrySchema = z.object({
  pid: z.number().int().positive(),
  appId: z.string(),
  startedAt: z.number().int().nonnegative(),
  cwd: z.string(),
  /** 自动生成的短 id（前 6 位 pid 哈希），方便 /exit 1 这种交互 */
  shortId: z.string(),
});

const ProcessesFileSchema = z.object({
  version: z.literal(1).default(1),
  processes: z.array(ProcessEntrySchema).default([]),
});

export type ProcessEntry = z.infer<typeof ProcessEntrySchema>;
type ProcessesFile = z.infer<typeof ProcessesFileSchema>;

const log = () => getLogger().child({ module: 'process-registry' });

function readFile(): ProcessesFile {
  if (!existsSync(PROCESSES_FILE)) {
    return ProcessesFileSchema.parse({});
  }
  try {
    const raw = readFileSync(PROCESSES_FILE, 'utf-8');
    const parsed = ProcessesFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return ProcessesFileSchema.parse({});
    return parsed.data;
  } catch {
    return ProcessesFileSchema.parse({});
  }
}

function writeFile(data: ProcessesFile): void {
  ensureDataDirs();
  writeFileSync(PROCESSES_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(PROCESSES_FILE)) {
    writeFileSync(PROCESSES_FILE, '{}\n', { mode: 0o600 });
  }
  const release = await lockfile.lock(PROCESSES_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

/** 检查 pid 是否仍然存活（不发信号，只用 kill(pid, 0) 探测）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // EPERM 表示有人，只是没权限——也当存活
    return code === 'EPERM';
  }
}

function shortIdOf(pid: number): string {
  return pid.toString(36).padStart(6, '0').slice(-6);
}

/**
 * 列出所有当前注册的 bridge 进程（自动剔除已死的条目）。
 */
export async function listProcesses(): Promise<ProcessEntry[]> {
  return withLock(() => {
    const data = readFile();
    const alive = data.processes.filter((p) => isAlive(p.pid));
    if (alive.length !== data.processes.length) {
      data.processes = alive;
      writeFile(data);
    }
    return alive;
  });
}

/**
 * 注册当前进程。重复注册（相同 pid）会替换旧条目。
 */
export async function registerSelf(appId: string): Promise<ProcessEntry> {
  const entry: ProcessEntry = {
    pid: process.pid,
    appId,
    startedAt: Date.now(),
    cwd: process.cwd(),
    shortId: shortIdOf(process.pid),
  };
  await withLock(() => {
    const data = readFile();
    data.processes = data.processes.filter((p) => p.pid !== process.pid && isAlive(p.pid));
    data.processes.push(entry);
    writeFile(data);
  });
  log().info({ pid: entry.pid, appId, shortId: entry.shortId }, 'process registered');
  return entry;
}

/**
 * 注销当前进程（在 SIGINT/SIGTERM 钩子里调）。
 */
export async function unregisterSelf(): Promise<void> {
  await withLock(() => {
    const data = readFile();
    const before = data.processes.length;
    data.processes = data.processes.filter((p) => p.pid !== process.pid);
    if (data.processes.length !== before) writeFile(data);
  });
}

/**
 * 通过 pid 或 shortId 查找进程。
 * idOrShort 可以是：
 *   - 完整 pid（数字字符串）
 *   - shortId
 *   - "#N" 形式的 1-based 序号（对应 listProcesses 的顺序）
 */
export async function findProcess(idOrShort: string): Promise<ProcessEntry | undefined> {
  const list = await listProcesses();
  const s = idOrShort.trim();
  if (s.startsWith('#')) {
    const idx = Number(s.slice(1)) - 1;
    return idx >= 0 && idx < list.length ? list[idx] : undefined;
  }
  // 数字 pid
  if (/^\d+$/.test(s)) {
    const pid = Number(s);
    const byPid = list.find((p) => p.pid === pid);
    if (byPid) return byPid;
  }
  // shortId
  return list.find((p) => p.shortId === s.toLowerCase());
}
