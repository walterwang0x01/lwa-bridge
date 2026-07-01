/**
 * Git 资产分发：Skill 和 Persona 的团队分发共用底层模块。
 *
 * 职责：
 *   - 同步 Git 仓库（clone / pull）到本地缓存目录
 *   - 发现仓库中的候选资产（按 kind 区分：skill 目录 vs agent JSON 文件）
 *   - 安装候选资产到 Kiro 标准目录（不覆盖已存在）
 *   - 记录安装日志（用于 Dashboard 展示和审计）
 *
 * 安全边界：
 *   - sync 只是 clone/pull，不触发任何安装
 *   - install 必须由上层（确认卡片按钮 action）显式调用
 *   - 已存在同名资产时拒绝覆盖
 */
import { existsSync, readdirSync, readFileSync, statSync, cpSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { getLogger } from '../lib/logger.js';
import { ASSET_SOURCES_DIR } from '../lib/paths.js';
import {
  type AssetKind,
  type AssetSourceEntry,
  type AssetInstallRecord,
  getSource,
  addInstallRecord,
  listInstalls as storeListInstalls,
} from './store.js';

const log = () => getLogger().child({ module: 'git-asset-source' });

export interface AssetCandidate {
  /** skill: 目录名；agent: 文件名去掉 .json */
  id: string;
  /** 展示用摘要 */
  summary: string;
  /** 本次 sync 后相对于已安装记录是否为新增 */
  isNew: boolean;
}

export interface InstallResult {
  installed: boolean;
  reason?: string;
}

// ─── 目标目录 ────────────────────────────────────────────────────

const SKILLS_DIR = join(homedir(), '.kiro', 'skills');
const AGENTS_DIR = join(homedir(), '.kiro', 'agents');

function targetDir(kind: AssetKind): string {
  return kind === 'skill' ? SKILLS_DIR : AGENTS_DIR;
}

function targetExists(kind: AssetKind, assetId: string): boolean {
  if (kind === 'skill') {
    return existsSync(join(SKILLS_DIR, assetId, 'SKILL.md'));
  }
  return existsSync(join(AGENTS_DIR, `${assetId}.json`));
}

// ─── sync ────────────────────────────────────────────────────────

/**
 * 同步一个已注册的 source：clone（首次）或 pull（已存在）。
 * 返回该 source 中发现的候选资产列表。
 */
export async function syncSource(sourceName: string): Promise<AssetCandidate[]> {
  const entry = await getSource(sourceName);
  if (!entry) throw new Error(`Source "${sourceName}" not found. Use /skill source list.`);

  const localDir = join(ASSET_SOURCES_DIR, sourceName);

  if (existsSync(join(localDir, '.git'))) {
    // 已 clone 过 → pull
    log().info({ source: sourceName, dir: localDir }, 'git pull');
    const r = await execa('git', ['pull', '--ff-only'], { cwd: localDir, reject: false });
    if (r.exitCode !== 0) {
      throw new Error(`git pull failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`);
    }
  } else {
    // 首次 → clone
    log().info({ source: sourceName, url: entry.gitUrl, dir: localDir }, 'git clone');
    mkdirSync(localDir, { recursive: true });
    const r = await execa('git', ['clone', '--depth', '1', entry.gitUrl, localDir], {
      reject: false,
    });
    if (r.exitCode !== 0) {
      throw new Error(`git clone failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`);
    }
  }

  return discoverCandidates(entry, localDir);
}

/**
 * 扫描 clone 下来的本地目录，按 kind 发现候选资产。
 */
function discoverCandidates(entry: AssetSourceEntry, localDir: string): AssetCandidate[] {
  const candidates: AssetCandidate[] = [];
  const installed = new Set<string>(); // 加载已安装记录用于标 isNew（同步版本，sync 不会并发）

  // 同步读取安装记录——sync 不是高频操作，同步 IO 可接受
  try {
    const raw = readFileSync(join(homedir(), '.lark-kiro-bridge', 'asset-installs.json'), 'utf-8');
    const data = JSON.parse(raw) as { installs?: AssetInstallRecord[] };
    if (data.installs) {
      for (const r of data.installs) {
        if (r.sourceName === entry.name) installed.add(r.assetId);
      }
    }
  } catch {
    // 文件不存在或不合法，视为无已安装记录
  }

  if (entry.kind === 'skill') {
    // 含 SKILL.md 的子目录即为候选 skill
    let entries: string[];
    try {
      entries = readdirSync(localDir);
    } catch {
      return [];
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const dir = join(localDir, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        if (!existsSync(join(dir, 'SKILL.md'))) continue;
      } catch {
        continue;
      }
      const summary = extractSkillDescription(join(dir, 'SKILL.md'));
      candidates.push({ id: name, summary, isNew: !installed.has(name) });
    }
  } else {
    // *.json 文件即为候选 agent
    let entries: string[];
    try {
      entries = readdirSync(localDir);
    } catch {
      return [];
    }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      if (!name.endsWith('.json')) continue;
      const filePath = join(localDir, name);
      try {
        if (!statSync(filePath).isFile()) continue;
      } catch {
        continue;
      }
      const id = basename(name, '.json');
      const summary = extractAgentDescription(filePath);
      candidates.push({ id, summary, isNew: !installed.has(id) });
    }
  }

  return candidates.sort((a, b) => a.id.localeCompare(b.id));
}

function extractSkillDescription(skillMdPath: string): string {
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const descMatch = content.match(/^description:\s*["']?(.*?)["']?\s*$/m);
    return descMatch?.[1]?.slice(0, 80) || '（无描述）';
  } catch {
    return '（无法读取）';
  }
}

function extractAgentDescription(jsonPath: string): string {
  try {
    const content = readFileSync(jsonPath, 'utf-8');
    const obj = JSON.parse(content) as { prompt?: string };
    if (obj.prompt) return obj.prompt.slice(0, 80);
    return '（无 prompt）';
  } catch {
    return '（解析失败）';
  }
}

// ─── install ─────────────────────────────────────────────────────

/**
 * 从已 sync 的本地缓存目录安装一个候选资产到 Kiro 标准目录。
 * 不覆盖已存在同名资产。
 */
export async function installAsset(sourceName: string, assetId: string): Promise<InstallResult> {
  const entry = await getSource(sourceName);
  if (!entry) return { installed: false, reason: `Source "${sourceName}" not found` };

  const localDir = join(ASSET_SOURCES_DIR, sourceName);
  if (!existsSync(localDir)) {
    return { installed: false, reason: `Source "${sourceName}" not synced yet. Run sync first.` };
  }

  // 检查目标是否已存在
  if (targetExists(entry.kind, assetId)) {
    return { installed: false, reason: '已存在同名资产，未覆盖' };
  }

  // 确保目标目录存在
  const tDir = targetDir(entry.kind);
  mkdirSync(tDir, { recursive: true });

  if (entry.kind === 'skill') {
    const srcDir = join(localDir, assetId);
    if (!existsSync(join(srcDir, 'SKILL.md'))) {
      return { installed: false, reason: `Skill "${assetId}" not found in source` };
    }
    const destDir = join(SKILLS_DIR, assetId);
    cpSync(srcDir, destDir, { recursive: true });
  } else {
    const srcFile = join(localDir, `${assetId}.json`);
    if (!existsSync(srcFile)) {
      return { installed: false, reason: `Agent "${assetId}" not found in source` };
    }
    const destFile = join(AGENTS_DIR, `${assetId}.json`);
    cpSync(srcFile, destFile);
  }

  // 记录安装
  await addInstallRecord({
    assetKind: entry.kind,
    assetId,
    sourceName: entry.name,
    sourceGitUrl: entry.gitUrl,
    installedAt: Date.now(),
  });

  log().info({ source: sourceName, assetId, kind: entry.kind }, 'asset installed');
  return { installed: true };
}

// ─── re-export ───────────────────────────────────────────────────

export { storeListInstalls as listInstalls };
export type { AssetKind, AssetSourceEntry, AssetInstallRecord };
