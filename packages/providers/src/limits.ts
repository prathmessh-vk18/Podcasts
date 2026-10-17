import { ProviderError } from '@tangent/core';

/**
 * Token bucket for providers that throttle without telling us (Apple's iTunes API allows
 * roughly 20 requests per minute per IP). `acquire` waits for a token instead of failing.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSecond);
    this.last = t;
  }

  /** Serialised so concurrent callers queue fairly instead of all waking at once. */
  acquire(): Promise<void> {
    const next = this.queue.then(async () => {
      this.refill();
      if (this.tokens < 1) {
        await this.sleep(Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000));
        this.refill();
      }
      this.tokens -= 1;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

/**
 * Daily unit budget (YouTube Data API: 10,000 units/day by default, reset at midnight Pacific).
 * The store is pluggable: in-memory for one process, database-backed when running several instances.
 */
export interface QuotaStore {
  /** Atomically add `units` to today's usage if it stays within `limit`. Returns whether it was consumed. */
  tryConsume(key: string, day: string, units: number, limit: number): Promise<boolean>;
  used(key: string, day: string): Promise<number>;
}

export class MemoryQuotaStore implements QuotaStore {
  private readonly usage = new Map<string, number>();
  async tryConsume(key: string, day: string, units: number, limit: number): Promise<boolean> {
    const k = `${key}:${day}`;
    const current = this.usage.get(k) ?? 0;
    if (current + units > limit) return false;
    this.usage.set(k, current + units);
    return true;
  }
  async used(key: string, day: string): Promise<number> {
    return this.usage.get(`${key}:${day}`) ?? 0;
  }
}

/** YYYY-MM-DD in a given IANA time zone. */
export function dayIn(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export class QuotaBudget {
  constructor(
    private readonly store: QuotaStore,
    private readonly key: string,
    private readonly dailyLimit: number,
    private readonly timeZone = 'America/Los_Angeles',
    private readonly now: () => Date = () => new Date(),
  ) {}

  private today(): string {
    return dayIn(this.timeZone, this.now());
  }

  async remaining(): Promise<number> {
    return Math.max(0, this.dailyLimit - (await this.store.used(this.key, this.today())));
  }

  /** Reserve units before calling the provider, so we never start work we can't finish. */
  async consume(units: number, op: string): Promise<void> {
    const ok = await this.store.tryConsume(this.key, this.today(), units, this.dailyLimit);
    if (!ok) {
      throw new ProviderError({
        kind: 'quota_exceeded',
        platform: 'youtube',
        message: `Daily YouTube quota would be exceeded by "${op}" (${units} units). It resets at midnight Pacific time.`,
        reason: 'localBudget',
      });
    }
  }
}
