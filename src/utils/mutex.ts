/**
 * 基于 Promise 的互斥锁，确保同一时间只有一个异步任务在执行。
 * 使用场景：防止同步任务被并发多次触发。
 *
 * 用法：
 *   const mutex = new Mutex();
 *   await mutex.acquire();
 *   try { ... } finally { mutex.release(); }
 */
export class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  /** 获取锁；若已被占用则进入等待队列 */
  async acquire(): Promise<void> {
    return new Promise(resolve => {
      if (!this.locked) {
        this.locked = true;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  /** 释放锁，唤醒下一个等待者 */
  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }

  /** 检查锁是否已被占用 */
  isLocked(): boolean {
    return this.locked;
  }
}
