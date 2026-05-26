/**
 * 任务计划数据模型
 *
 * 设计目标：跟 ACP（Agent Client Protocol）的 todo_write 工具结构兼容，
 * 这样将来从 FilePlanSource 切到 AcpPlanSource 时无须改这层 schema。
 *
 * 字段命名也参照 ACP 习惯（snake_case 在 IO 层面，类型层用 camelCase）。
 *
 * 单个任务计划文件：~/.lark-kiro-bridge/plans/<chatId>/plan.json
 *   - <chatId> 用 chat 的 oc_xxx
 *   - 同一 chat 同一时刻只有一个 active plan（新计划覆盖旧）
 */
import { z } from 'zod';

/**
 * 单步状态：
 *   pending     待开始
 *   in_progress 进行中
 *   done        已完成
 *   failed      失败（带 error 描述）
 *   skipped     跳过（用户取消 / 条件不满足）
 */
export const PlanItemStatusSchema = z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']);
export type PlanItemStatus = z.infer<typeof PlanItemStatusSchema>;

export const PlanItemSchema = z.object({
  /** 业务 id，可读，比如 'write-html' / 'screenshot-1' */
  id: z.string().min(1),
  /** 卡片上展示的简短标题，<= 50 字符 */
  title: z.string().min(1).max(200),
  /** 当前状态 */
  status: PlanItemStatusSchema,
  /** 可选：进行中或失败时的更长说明，<= 200 字符 */
  detail: z.string().max(500).optional(),
  /** 时间戳（毫秒） */
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

/**
 * 整体计划状态：
 *   planning   规划中（用户还没确认）
 *   running    执行中
 *   completed  全部完成
 *   failed     至少一项 failed 且没有继续
 *   cancelled  用户取消
 */
export const PlanStatusSchema = z.enum(['planning', 'running', 'completed', 'failed', 'cancelled']);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const PlanSchema = z.object({
  /** schema 版本号；不兼容改动时升 */
  version: z.literal(1).default(1),
  chatId: z.string().min(1),
  /** 整体状态 */
  status: PlanStatusSchema,
  /** 步骤列表，按时序 */
  items: z.array(PlanItemSchema).default([]),
  /** Kiro 给整个计划的简短描述（卡片标题用），<= 100 字符 */
  title: z.string().max(200).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Plan = z.infer<typeof PlanSchema>;

/** 计算进度：(done + skipped) / total，范围 0..1 */
export function planProgress(plan: Plan): number {
  if (plan.items.length === 0) return 0;
  const finished = plan.items.filter((i) => i.status === 'done' || i.status === 'skipped').length;
  return finished / plan.items.length;
}

/** 是否所有 step 都已终态（done/failed/skipped） */
export function planAllSettled(plan: Plan): boolean {
  return plan.items.every(
    (i) => i.status === 'done' || i.status === 'failed' || i.status === 'skipped',
  );
}
