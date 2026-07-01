/**
 * 资产来源 / 安装记录持久化
 *
 * 两个文件：
 *   - asset-sources.json：注册的 Git 资产来源列表
 *   - asset-installs.json：已安装资产的审计记录
 *
 * 读写模式完全照抄 src/store/workspaces.ts（zod schema + proper-lockfile）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { ASSET_SOURCES_FILE, ASSET_INSTALLS_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';

const log = () => getLogger().child({ module: 'asset-store' });

// ─── 类型 ────────────────────────────────────────────────────────

export type AssetKind = 'skill' | 'agent';

export interface AssetSourceEntry {
  name: string;
  gitUrl: string;
  kind: AssetKind;
  addedAt: number;
}

export interface AssetInstallRecord {
  assetKind: AssetKind;
  assetId: string;
  sourceName: string;
  sourceGitUrl: string;
  installedAt: number;
}

// ─── Schema ──────────────────────────────────────────────────────

const AssetSourceEntrySchema = z.object({
  name: z.string().min(1),
  gitUrl: z.string().min(1),
  kind: z.enum(['skill', 'agent']),
  addedAt: z.number(),
});

const SourcesFileSchema = z.object({
  version: z.literal(1).default(1),
  sources: z.array(AssetSourceEntrySchema).default([]),
});

const AssetInstallRecordSchema = z.object({
  assetKind: z.enum(['skill', 'agent']),
  assetId: z.string().min(1),
  sourceName: z.string().min(1),
  sourceGitUrl: z.string().min(1),
  installedAt: z.number(),
});

const InstallsFileSchema = z.object({
  version: z.literal(1).default(1),
  installs: z.array(AssetInstallRecordSchema).default([]),
});

type SourcesFile = z.infer<typeof SourcesFileSchema>;
type InstallsFile = z.infer<typeof InstallsFileSchema>;

// ─── 内部读写 ────────────────────────────────────────────────────

function readSourcesFile(): SourcesFile {
  if (!existsSync(ASSET_SOURCES_FILE)) return SourcesFileSchema.parse({});
  try {
    const raw = readFileSync(ASSET_SOURCES_FILE, 'utf-8');
    const parsed = SourcesFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'asset-sources.json validation failed, resetting');
      return SourcesFileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'asset-sources.json read failed, resetting');
    return SourcesFileSchema.parse({});
  }
}

function writeSourcesFile(data: SourcesFile): void {
  ensureDataDirs();
  writeFileSync(ASSET_SOURCES_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function readInstallsFile(): InstallsFile {
  if (!existsSync(ASSET_INSTALLS_FILE)) return InstallsFileSchema.parse({});
  try {
    const raw = readFileSync(ASSET_INSTALLS_FILE, 'utf-8');
    const parsed = InstallsFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'asset-installs.json validation failed, resetting');
      return InstallsFileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'asset-installs.json read failed, resetting');
    return InstallsFileSchema.parse({});
  }
}

function writeInstallsFile(data: InstallsFile): void {
  ensureDataDirs();
  writeFileSync(ASSET_INSTALLS_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

// ─── 锁 ─────────────────────────────────────────────────────────

async function withSourcesLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(ASSET_SOURCES_FILE)) writeFileSync(ASSET_SOURCES_FILE, '{}\n', { mode: 0o600 });
  const release = await lockfile.lock(ASSET_SOURCES_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

async function withInstallsLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(ASSET_INSTALLS_FILE)) writeFileSync(ASSET_INSTALLS_FILE, '{}\n', { mode: 0o600 });
  const release = await lockfile.lock(ASSET_INSTALLS_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

// ─── 公共 API ────────────────────────────────────────────────────

/** 名称规则：同 workspace name（字母数字 _ -，1-64 字符） */
const SOURCE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export async function addSource(entry: Omit<AssetSourceEntry, 'addedAt'>): Promise<void> {
  if (!SOURCE_NAME_PATTERN.test(entry.name)) {
    throw new Error(
      `Invalid source name "${entry.name}". Use letters, digits, "-" or "_" only (1–64 chars).`,
    );
  }
  await withSourcesLock(() => {
    const data = readSourcesFile();
    if (data.sources.some((s) => s.name === entry.name)) {
      throw new Error(`Source "${entry.name}" already exists. Remove it first.`);
    }
    data.sources.push({ ...entry, addedAt: Date.now() });
    writeSourcesFile(data);
  });
}

export async function listSources(kind?: AssetKind): Promise<AssetSourceEntry[]> {
  return withSourcesLock(() => {
    const data = readSourcesFile();
    return kind ? data.sources.filter((s) => s.kind === kind) : data.sources;
  });
}

export async function getSource(name: string): Promise<AssetSourceEntry | undefined> {
  return withSourcesLock(() => {
    const data = readSourcesFile();
    return data.sources.find((s) => s.name === name);
  });
}

export async function removeSource(name: string): Promise<boolean> {
  return withSourcesLock(() => {
    const data = readSourcesFile();
    const idx = data.sources.findIndex((s) => s.name === name);
    if (idx === -1) return false;
    data.sources.splice(idx, 1);
    writeSourcesFile(data);
    return true;
  });
}

export async function addInstallRecord(record: AssetInstallRecord): Promise<void> {
  await withInstallsLock(() => {
    const data = readInstallsFile();
    data.installs.push(record);
    writeInstallsFile(data);
  });
}

export async function listInstalls(kind?: AssetKind): Promise<AssetInstallRecord[]> {
  return withInstallsLock(() => {
    const data = readInstallsFile();
    return kind ? data.installs.filter((r) => r.assetKind === kind) : data.installs;
  });
}
