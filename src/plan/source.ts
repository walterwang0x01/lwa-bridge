/**
 * Plan 数据源抽象
 *
 * 当前实现：FilePlanSource — 监听 ~/.lark-kiro-bridge/plans/<chatId>/plan.json 变化
 * 未来实现：AcpPlanSource — 监听 ACP 协议事件流（Phase 2 ACP 迁移时新增）
 *
 * 关键设计：
 *   - PlanSource 只负责"取数据"，不负责"渲染"和"发卡片"
 *   - 数据源切换不影响 store / renderer / dispatcher
 *
 * FilePlanSource 实现细节：
 *   - 用 fs.watch 监听文件变化（rename + change 事件）
 *   - 读文件失败时静默重试（kiro 写一半 / 文件被删 都是正常情况）
 *   - debounce 100ms 防抖，避免一次写入触发多次 onUpdate
 *   - 文件期望由 kiro 用 atomic-rename 写入（先 .tmp 再 mv），如果 kiro
 *     直接覆写也不会崩，最差就是读到中间态被 zod 拒绝，下一次 watch 事件再读
 */
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { PLANS_DIR } from '../lib/paths.js';
import { PlanSchema, type Plan } from './types.js';

export interface PlanSource {
  /**
   * 启动监听。回调会在每次有效更新时触发（schema 校验通过）。
   * 如果启动时文件已存在，会立即触发一次回调。
   */
  start(onUpdate: (plan: Plan) => void): Promise<void>;
  /** 停止监听，释放 watch handle */
  stop(): void;
}

export class FilePlanSource implements PlanSource {
  private readonly chatId: string;
  private readonly log: Logger;
  private readonly chatDir: string;
  private readonly planFile: string;
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private lastEmittedJson = '';

  constructor(chatId: string, logger: Logger) {
    this.chatId = chatId;
    this.log = logger.child({ module: 'plan-source-file', chatId });
    this.chatDir = join(PLANS_DIR, sanitizeChatId(chatId));
    this.planFile = join(this.chatDir, 'plan.json');
  }

  async start(onUpdate: (plan: Plan) => void): Promise<void> {
    // 先看下当前文件是否已存在；如果有先 emit 一次（恢复场景：daemon 重启后读旧 plan）
    this.tryEmit(onUpdate);

    // 监听目录而不是单文件——文件被 mv 进来时单文件 watcher 会丢失
    // node 的 fs.watch 跨平台行为不一致，但监听目录在 macOS / Linux 都稳定
    if (!existsSync(this.chatDir)) {
      // 目录不存在就先不开 watcher；dispatcher 会在 task 启动时确保目录存在
      this.log.debug({ dir: this.chatDir }, 'plan dir not exist, watcher deferred');
      return;
    }
    this.watcher = watch(this.chatDir, (eventType, filename) => {
      if (filename !== 'plan.json') return;
      // debounce：kiro 用 mv 写入会触发多次事件，等 100ms 静默
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.tryEmit(onUpdate);
      }, 100);
    });
    this.log.debug('plan watcher started');
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
  }

  /**
   * 读文件 → 解析 → 跟上次 emit 内容比较去重 → 触发回调。
   *
   * 不抛异常：plan.json 不存在/读到一半/JSON 损坏/schema 不通过 都静默忽略。
   * 这些都是临时态，下一次文件事件会重试。
   */
  private tryEmit(onUpdate: (plan: Plan) => void): void {
    if (!existsSync(this.planFile)) return;
    let raw: string;
    try {
      raw = readFileSync(this.planFile, 'utf-8');
    } catch (e) {
      this.log.debug({ err: e }, 'plan read failed (transient, will retry)');
      return;
    }
    if (!raw || raw === this.lastEmittedJson) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.log.debug({ err: e, preview: raw.slice(0, 80) }, 'plan json parse failed');
      return;
    }
    const validated = PlanSchema.safeParse(parsed);
    if (!validated.success) {
      this.log.debug({ issues: validated.error.issues }, 'plan schema invalid');
      return;
    }
    this.lastEmittedJson = raw;
    try {
      onUpdate(validated.data);
    } catch (e) {
      this.log.warn({ err: e }, 'plan onUpdate handler threw');
    }
  }
}

/**
 * chatId 通常是 oc_xxx，只含字母数字下划线，理论上路径安全。
 * 防御性 sanitize 一下：保留字母数字下划线连字符，其他替换。
 */
function sanitizeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 给 dispatcher 用：构造该 chatId 的 plan 文件路径，方便注入到 prompt 让 kiro 知道写哪 */
export function planFilePathFor(chatId: string): string {
  return join(PLANS_DIR, sanitizeChatId(chatId), 'plan.json');
}

/** 给 dispatcher 用：构造该 chatId 的 plan 目录 */
export function planDirFor(chatId: string): string {
  return join(PLANS_DIR, sanitizeChatId(chatId));
}
