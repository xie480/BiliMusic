import LoggerService from '../services/LoggerService';

export type TaskPriority = 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

interface QueuedTask {
  execute: () => Promise<void>;
  priority: TaskPriority;
  id: number;
}

let nextId = 0;

export class TaskQueue {
  private running = 0;
  private queues: Record<number, QueuedTask[]> = { 0: [], 1: [], 2: [] };

  constructor(private concurrency: number) {}

  async add<T>(task: () => Promise<T>, priority: TaskPriority = 'normal'): Promise<T> {
    return new Promise((resolve, reject) => {
      const prioIdx = PRIORITY_ORDER[priority];
      this.queues[prioIdx].push({
        execute: async () => {
          try {
            resolve(await task());
          } catch (e) {
            reject(e);
          }
        },
        priority,
        id: nextId++,
      });
      this.process();
    });
  }

  get size(): number {
    return this.queues[0].length + this.queues[1].length + this.queues[2].length;
  }

  /** 清空所有待处理低优先级任务（例如用户在快速切歌时取消无用预加载） */
  clearLowPriority(): void {
    this.queues[2] = [];
  }

  clearAll(): void {
    this.queues[0] = [];
    this.queues[1] = [];
    this.queues[2] = [];
  }

  private async process() {
    if (this.running >= this.concurrency) return;

    const task = this.dequeue();
    if (!task) return;

    this.running++;
    try {
      await task.execute();
    } catch (e) {
      LoggerService.warn('TaskQueue', 'process', 'Task failed:', e);
    }
    this.running--;
    this.process();
  }

  private dequeue(): QueuedTask | undefined {
    for (let i = 0; i <= 2; i++) {
      const q = this.queues[i];
      if (q.length > 0) return q.shift();
    }
    return undefined;
  }
}
