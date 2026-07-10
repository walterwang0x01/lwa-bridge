/**
 * 数据目录与文件路径常量
 * 所有持久化数据放在 ~/.lwa/（首次启动自动从 ~/.lark-kiro-bridge 迁移）
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, renameSync, cpSync } from 'node:fs';
import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME } from './branding.js';

function homeRoot(): string {
  return process.env['LWA_HOME'] ?? homedir();
}

export const LEGACY_DATA_DIR = join(homeRoot(), LEGACY_DATA_DIR_NAME);
export const DATA_DIR = join(homeRoot(), DATA_DIR_NAME);
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const MEDIA_DIR = join(DATA_DIR, 'media');
export const PLANS_DIR = join(DATA_DIR, 'plans');
export const ASSET_SOURCES_DIR = join(DATA_DIR, 'asset-sources');

export const CONFIG_FILE = join(DATA_DIR, 'config.json');
export const SESSIONS_FILE = join(DATA_DIR, 'sessions.json');
export const WORKSPACES_FILE = join(DATA_DIR, 'workspaces.json');
export const PROCESSES_FILE = join(DATA_DIR, 'processes.json');
export const CRON_FILE = join(DATA_DIR, 'cron.json');
export const ACTIVE_CARDS_FILE = join(DATA_DIR, 'active-cards.json');
export const ASSET_SOURCES_FILE = join(DATA_DIR, 'asset-sources.json');
export const ASSET_INSTALLS_FILE = join(DATA_DIR, 'asset-installs.json');
export const TASK_HISTORY_FILE = join(DATA_DIR, 'task-history.json');

export type LegacyDataDirMigration = 'none' | 'renamed' | 'copied' | 'skipped' | 'both_exist';

let migrationDone = false;

/**
 * 若 ~/.lwa 不存在而 ~/.lark-kiro-bridge 存在，则迁移数据目录。
 * 两者都存在时优先 ~/.lwa，并提示用户手动处理 legacy。
 */
export function migrateLegacyDataDir(): LegacyDataDirMigration {
  if (migrationDone) return 'skipped';
  migrationDone = true;

  const legacy = LEGACY_DATA_DIR;
  const data = DATA_DIR;

  if (existsSync(data)) {
    if (existsSync(legacy)) {
      console.warn(
        `[lwa] Both ~/${DATA_DIR_NAME} and ~/${LEGACY_DATA_DIR_NAME} exist; using ~/${DATA_DIR_NAME}. Remove or merge the legacy directory when ready.`,
      );
      return 'both_exist';
    }
    return 'none';
  }

  if (!existsSync(legacy)) return 'none';

  try {
    renameSync(legacy, data);
    console.warn(`[lwa] Migrated ~/${LEGACY_DATA_DIR_NAME} → ~/${DATA_DIR_NAME}`);
    return 'renamed';
  } catch {
    cpSync(legacy, data, { recursive: true });
    console.warn(
      `[lwa] Copied ~/${LEGACY_DATA_DIR_NAME} → ~/${DATA_DIR_NAME} (legacy directory kept)`,
    );
    return 'copied';
  }
}

/** 测试用：重置迁移状态（仅 vitest） */
export function _resetMigrationForTests(): void {
  migrationDone = false;
}

/**
 * 确保数据目录存在；权限 0700（只有当前用户可访问，因为里面有 App Secret）。
 */
export function ensureDataDirs(): void {
  migrateLegacyDataDir();
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(MEDIA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(PLANS_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(ASSET_SOURCES_DIR, { recursive: true, mode: 0o700 });
}
