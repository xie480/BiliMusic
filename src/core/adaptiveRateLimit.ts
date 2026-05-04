import { RateLimitError } from './errors';

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export class AdaptiveRateLimiter {
  private currentRate: number;
  private tokens: number;
  private lastRefill: number;
  private waitQueue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  
  private readonly minRate = 0.5;
  private readonly maxRate = 10;
  private successCount = 0;
  private readonly successThreshold = 5; // 连续成功5次后提速

  constructor(initialRate = 2) {
    this.currentRate = initialRate;
    this.tokens = initialRate;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / this.currentRate) * 1000;
    if (waitMs > 10000) {
      throw new RateLimitError('限流：请稍后再试');
    }
    // 加入等待队列，由 refill 精准唤醒并扣除令牌，避免惊群效应
    return new Promise((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
      this.scheduleWake();
    });
  }

  private scheduleWake() {
    if (this.timer) return;
    if (this.waitQueue.length === 0) return;
    const waitMs = Math.max(0, ((1 - this.tokens) / this.currentRate) * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refill();
      if (this.waitQueue.length > 0) {
        this.scheduleWake();
      }
    }, waitMs);
  }

  private get capacity() {
    return Math.max(1, this.currentRate);
  }

  private refill() {
    const now = Date.now();
    const delta = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.currentRate);
    this.lastRefill = now;
    // 尝试唤醒等待队列中的请求
    this.tryWake();
  }

  private tryWake() {
    while (this.waitQueue.length > 0 && this.tokens >= 1) {
      const waiter = this.waitQueue.shift()!;
      this.tokens -= 1; // 确保被唤醒的请求消耗令牌，维持并发上限
      waiter.resolve();
    }
  }

  reportSuccess() {
    this.successCount++;
    if (this.successCount >= this.successThreshold) {
      this.currentRate = Math.min(this.maxRate, this.currentRate + 0.5); // 和增
      this.successCount = 0;
    }
  }

  reportError(isRateLimit: boolean) {
    if (isRateLimit) {
      this.currentRate = Math.max(this.minRate, this.currentRate * 0.5); // 乘减
      this.tokens = Math.min(this.tokens, this.capacity);
      this.successCount = 0;
    }
  }
}

export const adaptiveBucket = new AdaptiveRateLimiter(2);
