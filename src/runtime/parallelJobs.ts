/**
 * 进程内并行 job 注册表（多 worktree 子会话）。
 * 同一进程内并发跑多个 conversationId；结果摘要回挂父会话。
 */
export type ParallelJobStatus = 'running' | 'done' | 'error';

export interface ParallelJob {
  id: string;
  parentConversationId: string;
  childConversationId: string;
  worktreeName: string;
  cwd: string;
  promptPreview: string;
  status: ParallelJobStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  summaryPreview?: string;
}

const jobs = new Map<string, ParallelJob>();

export function createParallelJob(
  partial: Omit<ParallelJob, 'id' | 'status' | 'startedAt'> & { id?: string },
): ParallelJob {
  const id = partial.id ?? `job-${Date.now().toString(36).slice(-6)}`;
  const job: ParallelJob = {
    ...partial,
    id,
    status: 'running',
    startedAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function updateParallelJob(
  id: string,
  patch: Partial<Pick<ParallelJob, 'status' | 'finishedAt' | 'error' | 'summaryPreview'>>,
): ParallelJob | undefined {
  const cur = jobs.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  jobs.set(id, next);
  return next;
}

export function listParallelJobs(parentId?: string): ParallelJob[] {
  const all = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  return parentId ? all.filter((j) => j.parentConversationId === parentId) : all;
}

export function getParallelJob(id: string): ParallelJob | undefined {
  return jobs.get(id) ?? [...jobs.values()].find((j) => j.id.endsWith(id));
}

/** 测试用 */
export function _resetParallelJobsForTests(): void {
  jobs.clear();
}
