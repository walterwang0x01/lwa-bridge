/**
 * CLI coding 工作区：启动时解析「当前该在哪个目录写代码」。
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { Config } from '../../lib/config.js';
import { isPathAllowed } from '../../lib/security.js';

/** 从 start 向上找 git 根；找不到返回 undefined。 */
export function findGitRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function shortenHomePath(abs: string): string {
  const home = homedir();
  if (abs === home) return '~';
  if (abs.startsWith(home + '/') || abs.startsWith(home + '\\')) {
    return '~' + abs.slice(home.length);
  }
  return abs;
}

/**
 * 解析 CLI 启动工作目录：
 * 1. process.cwd() 若在白名单
 * 2. 否则其 git root 若在白名单
 * 3. 否则 config.workspace.defaultCwd
 */
export function resolveCliLaunchCwd(config: Config, launchCwd = process.cwd()): string {
  const roots = config.workspace.allowedRoots;
  const candidates = [resolve(launchCwd)];
  const git = findGitRoot(launchCwd);
  if (git && git !== candidates[0]) candidates.push(git);
  candidates.push(resolve(config.workspace.defaultCwd));

  for (const c of candidates) {
    try {
      if (!existsSync(c) || !statSync(c).isDirectory()) continue;
      if (!isPathAllowed(c, roots)) continue;
      return c;
    } catch {
      // try next
    }
  }
  return resolve(config.workspace.defaultCwd);
}

export function gitBranch(cwd: string): string | undefined {
  try {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
    });
    if (r.status !== 0) return undefined;
    const b = (r.stdout ?? '').trim();
    return b && b !== 'HEAD' ? b : undefined;
  } catch {
    return undefined;
  }
}

export function formatCliStatusLine(opts: {
  cwd: string;
  profileName?: string;
  model?: string;
  conversationId?: string;
  ctxPct?: number;
  memLabel?: string;
}): string {
  const branch = gitBranch(opts.cwd);
  const parts = [shortenHomePath(opts.cwd)];
  if (branch) parts.push(`· ${branch}`);
  if (opts.conversationId) {
    const short = opts.conversationId.replace(/^cli-(code|chat)-?/, '');
    parts.push(`· ${short || opts.conversationId}`);
  }
  if (opts.profileName) {
    const eng = opts.model ? `${opts.profileName} · ${opts.model}` : opts.profileName;
    parts.push(`· ${eng}`);
  }
  if (opts.ctxPct !== undefined) parts.push(`· ctx ${opts.ctxPct}%`);
  if (opts.memLabel) parts.push(`· mem ${opts.memLabel}`);
  return parts.join(' ');
}
