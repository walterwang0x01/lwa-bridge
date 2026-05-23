/**
 * 简单的 trailing-edge debounce：
 * 多次调用 schedule，只有最后一次会在 delay 之后真正执行。
 * 用于流式卡片更新——避免短时间内多次 patchCard 把飞书 API 打挂。
 */
export class Debouncer {
  private timer: NodeJS.Timeout | null = null;
  private pendingFn: (() => void | Promise<void>) | null = null;

  constructor(private readonly delayMs: number) {}

  schedule(fn: () => void | Promise<void>): void {
    this.pendingFn = fn;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const f = this.pendingFn;
      this.pendingFn = null;
      if (f) {
        Promise.resolve(f()).catch((err) => {
          // 静默吞错，避免影响主流程；具体处理由调用方 fn 自己包装。
          console.error('[debouncer] task failed:', err);
        });
      }
    }, this.delayMs);
  }

  /**
   * 立刻执行最近一次 schedule 的任务（如果有），并取消计时器。
   */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const f = this.pendingFn;
    this.pendingFn = null;
    if (f) await f();
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingFn = null;
  }
}
