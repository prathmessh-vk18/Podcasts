import type { Logger } from '@tangent/providers';

/**
 * In-process job queue with bounded concurrency and de-duplication by key.
 * Durable state lives in the database (job status), so a restart loses nothing: on boot the
 * app re-enqueues jobs that were mid-flight. Swap this for a distributed queue (e.g. pg-boss)
 * when running more than one worker; the interface stays the same.
 */
export class JobQueue {
  private running = 0;
  private readonly pending: Array<{ key: string; fn: () => Promise<void> }> = [];
  private readonly active = new Set<string>();
  private idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly concurrency: number,
    private readonly logger: Logger,
  ) {}

  /** Returns false if a job with this key is already queued or running. */
  enqueue(key: string, fn: () => Promise<void>): boolean {
    if (this.closed) return false;
    if (this.active.has(key) || this.pending.some((p) => p.key === key)) return false;
    this.pending.push({ key, fn });
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.running++;
      this.active.add(job.key);
      job
        .fn()
        .catch((err) =>
          this.logger.error(
            { key: job.key, err: (err as Error)?.message, stack: (err as Error)?.stack },
            'job crashed',
          ),
        )
        .finally(() => {
          this.running--;
          this.active.delete(job.key);
          this.pump();
          if (this.running === 0 && this.pending.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
    }
  }

  /** Resolves when nothing is queued or running. Used for graceful shutdown and tests. */
  onIdle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop accepting work; in-flight jobs finish. Queued-but-not-started jobs stay "planning"/"running" in the DB and resume on next boot. */
  async close(timeoutMs = 25_000): Promise<void> {
    this.closed = true;
    this.pending.length = 0;
    await Promise.race([this.onIdle(), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}
