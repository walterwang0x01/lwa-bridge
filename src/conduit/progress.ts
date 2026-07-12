/**
 * Conduit 结构化进度状态机：消费 NDJSON 事件，生成卡片/CLI 共用的短摘要。
 */
import type { ConduitEvent } from './events.js';

export type TaskProgressStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface TaskProgress {
  status: TaskProgressStatus;
  attempt: number;
  maxAttempts: number;
  failedLayer?: string | null;
}

export interface MergeProgress {
  state: 'pending' | 'running' | 'merged' | 'failed';
  error?: string | null;
}

export interface ConduitProgressState {
  currentWave: number;
  totalWaves: number;
  waveTaskIds: string[];
  tasks: Record<string, TaskProgress>;
  merges: Record<string, MergeProgress>;
  runCompleted?: {
    passedCount: number;
    failedCount: number;
    skippedCount: number;
  };
  lastEventType?: string;
  eventCount: number;
}

export function createEmptyProgress(): ConduitProgressState {
  return {
    currentWave: 0,
    totalWaves: 0,
    waveTaskIds: [],
    tasks: {},
    merges: {},
    eventCount: 0,
  };
}

export function applyConduitEvent(
  state: ConduitProgressState,
  event: ConduitEvent,
): ConduitProgressState {
  const next: ConduitProgressState = {
    ...state,
    tasks: { ...state.tasks },
    merges: { ...state.merges },
    waveTaskIds: [...state.waveTaskIds],
    eventCount: state.eventCount + 1,
    lastEventType: event.type,
  };

  switch (event.type) {
    case 'WaveStarted':
      next.currentWave = event.wave_index;
      next.totalWaves = event.total_waves;
      next.waveTaskIds = [...event.task_ids];
      for (const tid of event.task_ids) {
        if (!next.tasks[tid]) {
          next.tasks[tid] = { status: 'pending', attempt: 0, maxAttempts: 0 };
        }
      }
      break;
    case 'TaskStarted':
      next.tasks[event.task_id] = {
        status: 'running',
        attempt: event.attempt,
        maxAttempts: event.max_attempts,
      };
      break;
    case 'TaskFinished':
      next.tasks[event.task_id] = {
        status: event.passed ? 'passed' : 'failed',
        attempt: event.attempt,
        maxAttempts: next.tasks[event.task_id]?.maxAttempts ?? event.attempt,
        failedLayer: event.failed_layer ?? null,
      };
      break;
    case 'MergeStarted':
      next.merges[event.task_id] = { state: 'running' };
      break;
    case 'MergeFinished':
      next.merges[event.task_id] = {
        state: event.merged ? 'merged' : 'failed',
        error: event.error ?? null,
      };
      break;
    case 'RunCompleted':
      next.runCompleted = {
        passedCount: event.passed_count,
        failedCount: event.failed_count,
        skippedCount: event.skipped_count,
      };
      break;
    case 'LockEvent':
      break;
  }
  return next;
}

function countByStatus(tasks: Record<string, TaskProgress>): {
  pending: number;
  running: number;
  passed: number;
  failed: number;
} {
  const c = { pending: 0, running: 0, passed: 0, failed: 0 };
  for (const t of Object.values(tasks)) {
    c[t.status] += 1;
  }
  return c;
}

/** CLI / 飞书卡片 / 底栏共用的单行摘要。 */
export function formatProgressOneLiner(state: ConduitProgressState): string {
  const parts: string[] = [];
  if (state.totalWaves > 0) {
    parts.push(`Wave ${state.currentWave}/${state.totalWaves}`);
  }
  const c = countByStatus(state.tasks);
  const total = c.pending + c.running + c.passed + c.failed;
  if (total > 0) {
    parts.push(`✅${c.passed} 🏃${c.running} ⏳${c.pending}${c.failed ? ` ❌${c.failed}` : ''}`);
  }
  const running = Object.entries(state.tasks)
    .filter(([, t]) => t.status === 'running')
    .map(([id]) => id)
    .slice(0, 2);
  if (running.length) parts.push(running.join(', '));
  return parts.length ? `Conduit ${parts.join(' · ')}` : 'Conduit running…';
}

/** CLI / 飞书卡片共用的短摘要。 */
export function formatProgressText(state: ConduitProgressState): string {
  const lines: string[] = [];
  if (state.totalWaves > 0) {
    lines.push(`Wave ${state.currentWave}/${state.totalWaves}`);
  }
  const c = countByStatus(state.tasks);
  const total = c.pending + c.running + c.passed + c.failed;
  if (total > 0) {
    lines.push(`Tasks: ✅${c.passed} ❌${c.failed} 🏃${c.running} ⏳${c.pending} (共 ${total})`);
  }
  const running = Object.entries(state.tasks)
    .filter(([, t]) => t.status === 'running')
    .map(([id, t]) => `${id}#${t.attempt}`)
    .slice(0, 5);
  if (running.length) {
    lines.push(`Running: ${running.join(', ')}`);
  }
  const mergeRunning = Object.entries(state.merges)
    .filter(([, m]) => m.state === 'running')
    .map(([id]) => id);
  if (mergeRunning.length) {
    lines.push(`Merging: ${mergeRunning.join(', ')}`);
  }
  if (state.runCompleted) {
    const r = state.runCompleted;
    lines.push(`Done: passed=${r.passedCount} failed=${r.failedCount} skipped=${r.skippedCount}`);
  } else if (state.lastEventType) {
    lines.push(`Last: ${state.lastEventType}`);
  }
  return lines.length ? lines.join('\n') : '等待事件…';
}
