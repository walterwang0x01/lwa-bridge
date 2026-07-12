/**
 * 读 `.lwa-conduit/run-state.json`（兼容 `.kiro-conduit`）生成跑完摘要。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunStateTask {
  status: string;
  branch?: string | null;
  attempts?: number;
  last_failure_feedback?: string | null;
  last_failed_layer?: string | null;
}

export interface RunStateFile {
  version?: number;
  base_branch?: string;
  tasks?: Record<string, RunStateTask>;
}

export interface ConduitRunSummary {
  dirName: string;
  baseBranch?: string;
  passed: string[];
  failed: string[];
  skipped: string[];
  pending: string[];
  branches: Array<{ taskId: string; branch: string; status: string }>;
  reviewSnippet?: string;
}

const DIR_CANDIDATES = ['.lwa-conduit', '.kiro-conduit'] as const;

export function resolveConduitDir(cwd: string): string | null {
  for (const name of DIR_CANDIDATES) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function loadRunState(cwd: string): { dir: string; state: RunStateFile } | null {
  const dir = resolveConduitDir(cwd);
  if (!dir) return null;
  const path = join(dir, 'run-state.json');
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as RunStateFile;
    return { dir, state };
  } catch {
    return null;
  }
}

export function summarizeRunState(cwd: string): ConduitRunSummary | null {
  const loaded = loadRunState(cwd);
  if (!loaded) return null;
  const { dir, state } = loaded;
  const tasks = state.tasks ?? {};
  const passed: string[] = [];
  const failed: string[] = [];
  const skipped: string[] = [];
  const pending: string[] = [];
  const branches: ConduitRunSummary['branches'] = [];

  for (const [taskId, t] of Object.entries(tasks)) {
    const status = (t.status ?? 'pending').toLowerCase();
    if (status === 'passed') passed.push(taskId);
    else if (status === 'failed') failed.push(taskId);
    else if (status === 'skipped') skipped.push(taskId);
    else pending.push(taskId);
    if (t.branch) {
      branches.push({ taskId, branch: t.branch, status });
    }
  }

  let reviewSnippet: string | undefined;
  const reviewPath = join(dir, 'review.md');
  if (existsSync(reviewPath)) {
    try {
      const raw = readFileSync(reviewPath, 'utf8').trim();
      reviewSnippet = raw.length > 800 ? `${raw.slice(0, 800)}…` : raw;
    } catch {
      /* ignore */
    }
  }

  return {
    dirName: dir.split(/[/\\]/).pop() ?? dir,
    baseBranch: state.base_branch,
    passed,
    failed,
    skipped,
    pending,
    branches,
    reviewSnippet,
  };
}

export function formatRunSummary(summary: ConduitRunSummary): string {
  const lines: string[] = [`状态目录：\`${summary.dirName}/\``];
  if (summary.baseBranch) {
    lines.push(`Base：\`${summary.baseBranch}\``);
  }
  lines.push(
    `Tasks：✅ ${summary.passed.length}  ❌ ${summary.failed.length}  ⏭ ${summary.skipped.length}  ⏳ ${summary.pending.length}`,
  );
  if (summary.passed.length) {
    lines.push(`Passed：${summary.passed.join(', ')}`);
  }
  if (summary.failed.length) {
    lines.push(`Failed：${summary.failed.join(', ')}`);
  }
  if (summary.branches.length) {
    lines.push('', 'Branches：');
    for (const b of summary.branches.slice(0, 20)) {
      lines.push(`- \`${b.branch}\` (${b.status})`);
    }
    if (summary.branches.length > 20) {
      lines.push(`… 另有 ${summary.branches.length - 20} 条`);
    }
  }
  if (summary.reviewSnippet) {
    lines.push('', 'Review：', '```', summary.reviewSnippet, '```');
  }
  return lines.join('\n');
}
