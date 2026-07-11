/**
 * Git worktree 辅助：给并行 agent 会话隔离工作树。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

function runGit(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new WorktreeError((err.stderr || err.message || String(e)).trim());
  }
}

export function findGitRoot(cwd: string): string | undefined {
  try {
    return runGit(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return undefined;
  }
}

export function defaultWorktreeParent(repoRoot: string): string {
  // 放在仓库内，保证落在 workspace.allowedRoots 下
  return join(repoRoot, '.lwa-worktrees');
}

export interface WorktreeInfo {
  path: string;
  branch?: string;
  bare?: boolean;
}

/** 解析 `git worktree list --porcelain` */
export function listWorktrees(repoRoot: string): WorktreeInfo[] {
  const out = runGit(repoRoot, ['worktree', 'list', '--porcelain']);
  const items: WorktreeInfo[] = [];
  let cur: WorktreeInfo | undefined;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) items.push(cur);
      cur = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'bare' && cur) {
      cur.bare = true;
    }
  }
  if (cur) items.push(cur);
  return items;
}

export function addWorktree(
  repoRoot: string,
  name: string,
  opts?: { baseRef?: string; parentDir?: string },
): { path: string; branch: string } {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name)) {
    throw new WorktreeError('worktree name: only [a-zA-Z0-9._-], max 64');
  }
  const parent = opts?.parentDir ?? defaultWorktreeParent(repoRoot);
  mkdirSync(parent, { recursive: true });
  const path = join(parent, name);
  if (existsSync(path)) {
    throw new WorktreeError(`path already exists: ${path}`);
  }
  const branch = `lwa/${name}`;
  const base = opts?.baseRef ?? 'HEAD';
  // 新建分支并挂 worktree
  runGit(repoRoot, ['worktree', 'add', '-b', branch, path, base]);
  return { path, branch };
}

export function removeWorktree(repoRoot: string, pathOrName: string): string {
  const list = listWorktrees(repoRoot);
  const hit =
    list.find((w) => w.path === pathOrName) ?? list.find((w) => basename(w.path) === pathOrName);
  if (!hit) throw new WorktreeError(`worktree not found: ${pathOrName}`);
  if (hit.path === repoRoot) throw new WorktreeError('cannot remove main worktree');
  runGit(repoRoot, ['worktree', 'remove', '--force', hit.path]);
  // 尝试删掉 lwa/ 分支（忽略失败）
  if (hit.branch?.startsWith('lwa/')) {
    try {
      runGit(repoRoot, ['branch', '-D', hit.branch]);
    } catch {
      // ignore
    }
  }
  return hit.path;
}
