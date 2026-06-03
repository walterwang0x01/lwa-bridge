/**
 * 最小异步队列：push 入队、take 异步取（可先于 push 等待）、close 收尾。
 * 不引入外部依赖。close 之后 take 在取空残留后返回 QUEUE_CLOSED 结束信号。
 */

/** 队列关闭信号。take 返回它表示不会再有新元素。 */
export const QUEUE_CLOSED = Symbol('queue-closed');

export class AsyncQueue<T> {
  private items: T[] = [];
  private takers: Array<(value: T | typeof QUEUE_CLOSED) => void> = [];
  private closed = false;

  /** 入队。已关闭则丢弃。若有等待者直接投递。 */
  push(item: T): void {
    if (this.closed) return;
    const taker = this.takers.shift();
    if (taker) {
      taker(item);
    } else {
      this.items.push(item);
    }
  }

  /** 取一个元素。无元素则等待，直到 push 或 close。 */
  take(): Promise<T | typeof QUEUE_CLOSED> {
    if (this.items.length > 0) {
      return Promise.resolve(this.items.shift() as T);
    }
    if (this.closed) {
      return Promise.resolve(QUEUE_CLOSED);
    }
    return new Promise((resolve) => {
      this.takers.push(resolve);
    });
  }

  /** 关闭队列，唤醒所有等待者返回结束信号。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const takers = this.takers;
    this.takers = [];
    for (const taker of takers) taker(QUEUE_CLOSED);
  }
}
