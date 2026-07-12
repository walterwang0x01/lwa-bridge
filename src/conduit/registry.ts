/**
 * 进行中的 conduit run 注册表（进程内共享：CLI 底栏 / Dashboard）。
 */
import type { ConduitProgressState } from './progress.js';
import { createEmptyProgress } from './progress.js';

export interface ActiveConduitRun {
  conversationId: string;
  cwd: string;
  startedAt: number;
  progress: ConduitProgressState;
  textTail: string;
}

export class ConduitRunRegistry {
  private readonly runs = new Map<string, ActiveConduitRun>();

  start(conversationId: string, cwd: string): void {
    this.runs.set(conversationId, {
      conversationId,
      cwd,
      startedAt: Date.now(),
      progress: createEmptyProgress(),
      textTail: '',
    });
  }

  update(
    conversationId: string,
    patch: { progress?: ConduitProgressState; textTail?: string },
  ): void {
    const run = this.runs.get(conversationId);
    if (!run) return;
    if (patch.progress) run.progress = patch.progress;
    if (patch.textTail !== undefined) run.textTail = patch.textTail;
  }

  finish(conversationId: string): void {
    this.runs.delete(conversationId);
  }

  get(conversationId: string): ActiveConduitRun | undefined {
    return this.runs.get(conversationId);
  }

  listActive(): ActiveConduitRun[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 任意会话是否有活跃 conduit */
  hasActive(): boolean {
    return this.runs.size > 0;
  }
}

export const sharedConduitRegistry = new ConduitRunRegistry();
