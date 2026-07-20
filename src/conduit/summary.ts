/**
 * 读 `.lwa-conduit/run-state.json`（兼容 `.kiro-conduit`）生成跑完摘要。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/**
 * 检测 cwd 下是否已经有 `/conduit plan` 产出的 dag.yaml（在默认输出目录
 * `.conduit-plan/dag.yaml` 下），或者用户自己手写/放在 cwd 根目录的
 * `dag.yaml`。用于 `/conduit`（无参数）的分步引导：区分"从未 plan 过"和
 * "已经 plan 好，等着 run"这两种状态，给出不同的下一步提示。
 */
export function findConduitDagPath(cwd: string): string | null {
  const candidates = [join(cwd, '.conduit-plan', 'dag.yaml'), join(cwd, 'dag.yaml')];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * `lwa-conduit run --workspace <dir>` 的 `<dir>` 必须是"直接包含 dag.yaml
 * 的目录"，不是项目根目录。`/conduit plan` 默认把 dag.yaml 产出到
 * `<cwd>/.conduit-plan/dag.yaml`，如果 `/conduit run` 直接把 cwd 传给
 * --workspace，会报 "no dag.yaml in workspace dir"——即使用户完全按照
 * plan 输出的提示（"已生成 .conduit-plan/dag.yaml，用 /conduit run 执行"）
 * 操作，也会失败。这个函数把 findConduitDagPath 找到的文件路径转换成
 * --workspace 应该传的目录：dag.yaml 所在的那一层，不是 cwd 本身。
 */
export function resolveConduitWorkspaceDir(cwd: string): string | null {
  const dagPath = findConduitDagPath(cwd);
  if (!dagPath) return null;
  return dirname(dagPath);
}

export function resolveConduitDir(cwd: string): string | null {
  for (const name of DIR_CANDIDATES) {
    const p = join(cwd, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 判断一次 `lwa-conduit run` 的失败结果，是不是被 CLI 自带的"裸重跑守卫"
 * 拒绝执行（发现上次有已完成任务、但这次既没 --resume 也没 --fresh），而
 * 不是"任务真的跑了、但部分失败"。两者需要给用户不同的提示：前者根本没跑，
 * 后者是跑完了但结果不理想。用 stdout 里守卫打印的固定中文提示句子判断。
 */
export function isBareRerunGuardResult(r: {
  ok: boolean;
  notFound: boolean;
  aborted: boolean;
  timedOut: boolean;
  output: string;
}): boolean {
  return (
    !r.ok && !r.notFound && !r.aborted && !r.timedOut && r.output.includes('发现上次运行的进度')
  );
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
