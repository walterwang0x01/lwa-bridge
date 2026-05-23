/**
 * 命名工作区持久化
 *
 * 数据模型：name → absolutePath
 * 用于 /ws save/use/list/remove 命令。命名工作区是用户友好的目录别名，
 * 比如 "brand" → "/Users/administrator/PycharmProjects/personal-brand-agent"。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { WORKSPACES_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const WorkspacesFileSchema = z.object({
  version: z.literal(1).default(1),
  workspaces: z.record(z.string(), z.string()).default({}),
});

export type WorkspacesFile = z.infer<typeof WorkspacesFileSchema>;

const log = () => getLogger().child({ module: 'workspaces' });

function readFile(): WorkspacesFile {
  if (!existsSync(WORKSPACES_FILE)) {
    return WorkspacesFileSchema.parse({});
  }
  try {
    const raw = readFileSync(WORKSPACES_FILE, 'utf-8');
    const parsed = WorkspacesFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'workspaces.json validation failed, resetting');
      return WorkspacesFileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'workspaces.json read failed, resetting');
    return WorkspacesFileSchema.parse({});
  }
}

function writeFile(data: WorkspacesFile): void {
  ensureDataDirs();
  writeFileSync(WORKSPACES_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(WORKSPACES_FILE)) {
    writeFileSync(WORKSPACES_FILE, '{}\n', { mode: 0o600 });
  }
  const release = await lockfile.lock(WORKSPACES_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export class WorkspaceStore {
  async list(): Promise<Record<string, string>> {
    return withLock(() => readFile().workspaces);
  }

  async get(name: string): Promise<string | undefined> {
    return withLock(() => readFile().workspaces[name]);
  }

  async save(name: string, absPath: string): Promise<void> {
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid workspace name "${name}". Use letters, digits, "-" or "_" only (1–64 chars).`,
      );
    }
    await withLock(() => {
      const data = readFile();
      data.workspaces[name] = absPath;
      writeFile(data);
    });
  }

  async remove(name: string): Promise<boolean> {
    return withLock(() => {
      const data = readFile();
      if (!(name in data.workspaces)) return false;
      delete data.workspaces[name];
      writeFile(data);
      return true;
    });
  }
}
