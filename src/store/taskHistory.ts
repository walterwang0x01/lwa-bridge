/**
 * 任务历史记录（只读展示用，Dashboard「任务历史」面板的数据源）
 *
 * 记录每次 Kiro 任务的终态摘要：跑了哪些工具、产出了哪些文件、耗时多久。
 * 不记录完整回复文本（可能很长且含敏感信息），只记录摘要。
 *
 * 容量控制：只保留最近 MAX_RECORDS 条（环形覆盖），避免文件无限增长。
 * 文件锁：proper-lockfile，跟 activeCards/sessions 一致的并发模式。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { TASK_HISTORY_FILE, ensureDataDirs } from '../lib/paths.js';
import { getLogger } from '../lib/logger.js';
import { evaluateApplySafeGates } from '../runtime/adaptive.js';

const log = () => getLogger().child({ module: 'task-history' });

const MAX_RECORDS = 200;

const TaskHistoryRecordSchema = z.object({
  taskId: z.string(),
  chatId: z.string(),
  cwd: z.string(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative(),
  /** 与 RunState.terminal 对齐（done/error/interrupted/idle_timeout/timeout） */
  terminal: z.string(),
  /** 用户 prompt 前 100 字符，脱敏展示用 */
  promptPreview: z.string(),
  toolCallCount: z.number().int().nonnegative(),
  /** 本次任务写入/编辑过的文件路径（去重），从 fs_write/fsWrite 等工具的 input.path 提取 */
  artifacts: z.array(z.string()).default([]),
  taskBucket: z.string().optional(),
  runtimeProfile: z.string().optional(),
  runtimeKind: z.string().optional(),
  model: z.string().optional(),
  complexityScore: z.number().int().nonnegative().optional(),
  errorMsg: z.string().optional(),
});

export type TaskHistoryRecord = z.infer<typeof TaskHistoryRecordSchema>;
export interface RuntimeMetricsRow {
  taskBucket: string;
  runtimeKind: string;
  model: string;
  total: number;
  success: number;
  failed: number;
  successRate: number;
  avgDurationMs: number;
  avgArtifacts: number;
  avgToolCalls: number;
  score: number;
}

export interface AdaptiveRuntimeRecommendation {
  preferredRuntimeKind?: string;
  preferredModel?: string;
  sampleSize: number;
  reason: string;
  runtimeSuccessRate?: number;
  modelSuccessRate?: number;
  runtimeScore?: number;
  modelScore?: number;
}

export const BRIDGE_TASK_BUCKETS = ['chat', 'review', 'plan', 'edit', 'conduit'] as const;

export interface AdaptiveBucketReadiness {
  taskBucket: string;
  sampleSize: number;
  recommendation: AdaptiveRuntimeRecommendation;
  canApplyRuntime: boolean;
  canApplyModel: boolean;
  rolloutReady: boolean;
}

export interface MetricsAlertRow {
  taskBucket: string;
  runtimeKind: string;
  model: string;
  total: number;
  failed: number;
  successRate: number;
  reason: 'low-success-rate';
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function costScoreFor(runtimeKind: string, model: string): number {
  if (runtimeKind === 'cursor-agent-cli') return 1;
  if (runtimeKind === 'gemini-cli') return 0.92;
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 0.35;
  if (lower.includes('sonnet')) return 0.65;
  if (lower.includes('haiku')) return 0.85;
  return 0.5;
}

function rowScore(
  row: Pick<
    RuntimeMetricsRow,
    'runtimeKind' | 'model' | 'successRate' | 'avgDurationMs' | 'avgArtifacts' | 'avgToolCalls'
  >,
): number {
  const speedScore = 1 / (1 + row.avgDurationMs / 30_000);
  const changeScore = 1 / (1 + row.avgArtifacts / 6);
  const toolScore = 1 / (1 + row.avgToolCalls / 12);
  const costScore = costScoreFor(row.runtimeKind, row.model);
  return clamp01(
    row.successRate * 0.65 +
      speedScore * 0.15 +
      costScore * 0.1 +
      changeScore * 0.05 +
      toolScore * 0.05,
  );
}

const FileSchema = z.object({
  version: z.literal(1).default(1),
  records: z.array(TaskHistoryRecordSchema).default([]),
});

type FileShape = z.infer<typeof FileSchema>;

function readFile(): FileShape {
  if (!existsSync(TASK_HISTORY_FILE)) return FileSchema.parse({});
  try {
    const raw = readFileSync(TASK_HISTORY_FILE, 'utf-8');
    const parsed = FileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log().warn({ err: parsed.error.issues }, 'task-history.json validation failed, resetting');
      return FileSchema.parse({});
    }
    return parsed.data;
  } catch (e) {
    log().warn({ err: e }, 'task-history.json read failed, resetting');
    return FileSchema.parse({});
  }
}

function writeFile(data: FileShape): void {
  ensureDataDirs();
  writeFileSync(TASK_HISTORY_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

async function withLock<T>(fn: () => T): Promise<T> {
  ensureDataDirs();
  if (!existsSync(TASK_HISTORY_FILE)) writeFileSync(TASK_HISTORY_FILE, '{}\n', { mode: 0o600 });
  const release = await lockfile.lock(TASK_HISTORY_FILE, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
    stale: 10_000,
  });
  try {
    return fn();
  } finally {
    await release();
  }
}

export class TaskHistoryStore {
  /** 追加一条记录；超过 MAX_RECORDS 时丢弃最旧的（环形覆盖）。 */
  async add(record: TaskHistoryRecord): Promise<void> {
    await withLock(() => {
      const data = readFile();
      data.records.push(record);
      if (data.records.length > MAX_RECORDS) {
        data.records.splice(0, data.records.length - MAX_RECORDS);
      }
      writeFile(data);
    });
  }

  /** 列出最近的记录，按时间倒序（最新在前）。limit 默认 50。 */
  async listRecent(limit = 50): Promise<TaskHistoryRecord[]> {
    return withLock(() => {
      const data = readFile();
      return [...data.records].reverse().slice(0, limit);
    });
  }

  async summarizeRuntimeMetrics(limit = 200, bucket?: string): Promise<RuntimeMetricsRow[]> {
    return withLock(() => {
      const data = readFile();
      const rows = new Map<string, RuntimeMetricsRow>();
      for (const record of data.records.slice(-limit)) {
        if (bucket && record.taskBucket !== bucket) continue;
        const taskBucket = record.taskBucket ?? '(unbucketed)';
        const runtimeKind = record.runtimeKind ?? 'unknown';
        const model = record.model ?? '(default)';
        const key = `${taskBucket}__${runtimeKind}__${model}`;
        const row = rows.get(key) ?? {
          taskBucket,
          runtimeKind,
          model,
          total: 0,
          success: 0,
          failed: 0,
          successRate: 0,
          avgDurationMs: 0,
          avgArtifacts: 0,
          avgToolCalls: 0,
          score: 0,
        };
        row.total += 1;
        const ok = record.terminal === 'done';
        if (ok) row.success += 1;
        else row.failed += 1;
        row.avgDurationMs += Math.max(0, record.finishedAt - record.startedAt);
        row.avgArtifacts += record.artifacts.length;
        row.avgToolCalls += record.toolCallCount;
        rows.set(key, row);
      }
      return [...rows.values()]
        .map((row) => ({
          ...row,
          successRate: row.total > 0 ? row.success / row.total : 0,
          avgDurationMs: row.total > 0 ? Math.round(row.avgDurationMs / row.total) : 0,
          avgArtifacts: row.total > 0 ? Number((row.avgArtifacts / row.total).toFixed(2)) : 0,
          avgToolCalls: row.total > 0 ? Number((row.avgToolCalls / row.total).toFixed(2)) : 0,
          score: rowScore({
            ...row,
            successRate: row.total > 0 ? row.success / row.total : 0,
            avgDurationMs: row.total > 0 ? Math.round(row.avgDurationMs / row.total) : 0,
            avgArtifacts: row.total > 0 ? row.avgArtifacts / row.total : 0,
            avgToolCalls: row.total > 0 ? row.avgToolCalls / row.total : 0,
          }),
        }))
        .sort((a, b) => b.score - a.score || b.successRate - a.successRate || b.total - a.total);
    });
  }

  async recommendAdaptiveStrategy(
    limit = 200,
    bucket?: string,
  ): Promise<AdaptiveRuntimeRecommendation> {
    const rows = await this.summarizeRuntimeMetrics(limit, bucket);
    const eligible = rows.filter((row) => row.total >= 3);
    if (eligible.length === 0) {
      return { sampleSize: 0, reason: 'insufficient-history' };
    }

    const runtimeRows = new Map<string, RuntimeMetricsRow>();
    for (const row of eligible) {
      const current = runtimeRows.get(row.runtimeKind);
      if (!current || row.score > current.score || row.successRate > current.successRate) {
        runtimeRows.set(row.runtimeKind, row);
      }
    }
    const bestRuntime = [...runtimeRows.values()].sort(
      (a, b) => b.score - a.score || b.successRate - a.successRate || b.total - a.total,
    )[0];
    const bestKiro = eligible
      .filter((row) => row.runtimeKind === 'kiro-cli-acp')
      .sort((a, b) => b.score - a.score || b.successRate - a.successRate || b.total - a.total)[0];

    return {
      preferredRuntimeKind:
        bestRuntime && bestRuntime.successRate >= 0.75 ? bestRuntime.runtimeKind : undefined,
      preferredModel: bestKiro && bestKiro.successRate >= 0.75 ? bestKiro.model : undefined,
      sampleSize: eligible.reduce((sum, row) => sum + row.total, 0),
      reason: 'history-multi-objective-score',
      runtimeSuccessRate: bestRuntime?.successRate,
      modelSuccessRate: bestKiro?.successRate,
      runtimeScore: bestRuntime?.score,
      modelScore: bestKiro?.score,
    };
  }

  /** 按桶评估 apply-safe 是否满足门禁（与 dispatcher 逻辑一致）。 */
  async evaluateApplySafeReadiness(limit = 200): Promise<AdaptiveBucketReadiness[]> {
    const out: AdaptiveBucketReadiness[] = [];
    for (const taskBucket of BRIDGE_TASK_BUCKETS) {
      const recommendation = await this.recommendAdaptiveStrategy(limit, taskBucket);
      const gates = evaluateApplySafeGates({
        sampleSize: recommendation.sampleSize,
        runtimeSuccessRate: recommendation.runtimeSuccessRate,
        modelSuccessRate: recommendation.modelSuccessRate,
      });
      out.push({
        taskBucket,
        sampleSize: recommendation.sampleSize,
        recommendation,
        canApplyRuntime: gates.canApplyRuntime,
        canApplyModel: gates.canApplyModel,
        rolloutReady: recommendation.sampleSize >= 30 && gates.canApplyRuntime,
      });
    }
    return out;
  }

  /** 样本足够但成功率偏低的组合，供 Dashboard 高亮。 */
  async listMetricsAlerts(
    limit = 200,
    minTotal = 3,
    maxSuccessRate = 0.75,
  ): Promise<MetricsAlertRow[]> {
    const rows = await this.summarizeRuntimeMetrics(limit);
    return rows
      .filter((row) => row.total >= minTotal && row.successRate < maxSuccessRate)
      .map((row) => ({
        taskBucket: row.taskBucket,
        runtimeKind: row.runtimeKind,
        model: row.model,
        total: row.total,
        failed: row.failed,
        successRate: row.successRate,
        reason: 'low-success-rate' as const,
      }))
      .sort((a, b) => a.successRate - b.successRate || b.failed - a.failed);
  }

  /** 当月各 runtimeKind 任务计数（用于配额 monthlyLimits）。 */
  async countMonthUsageByKind(): Promise<Record<string, number>> {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const since = startOfMonth.getTime();
    return withLock(() => {
      const data = readFile();
      const counts = new Map<string, number>();
      for (const record of data.records) {
        if (record.startedAt < since) continue;
        const kind = record.runtimeKind ?? 'unknown';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      return Object.fromEntries(counts);
    });
  }
}
