import type { Logger } from '@tangent/providers';
import { JobQueue } from './queue.js';

/**
 * Where background work runs.
 * - `server`: a long-lived process (local dev, containers) → bounded in-process queue.
 * - `serverless`: Vercel functions → the work is attached to the current invocation with
 *   `waitUntil`, so it keeps running after the HTTP response is sent (up to the function's
 *   max duration). If it's cut short, the job's lease expires and the next poll or cron
 *   tick resumes it.
 * Durable state always lives in Postgres; runners are just "where to execute".
 */
export interface JobRunner {
  enqueue(key: string, fn: () => Promise<void>): boolean;
  onIdle(): Promise<void>;
  close(timeoutMs?: number): Promise<void>;
}

type WaitUntil = (p: Promise<unknown>) => void;

export class ServerlessRunner implements JobRunner {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly waitUntil: WaitUntil,
    private readonly logger: Logger,
  ) {}

  enqueue(key: string, fn: () => Promise<void>): boolean {
    if (this.inflight.has(key)) return false;
    const p = fn()
      .catch((err) =>
        this.logger.error({ key, err: (err as Error)?.message, stack: (err as Error)?.stack }, 'job crashed'),
      )
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    this.waitUntil(p);
    return true;
  }

  async onIdle(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()]);
  }

  async close(timeoutMs = 10_000): Promise<void> {
    await Promise.race([this.onIdle(), new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}

export async function createRunner(
  mode: 'server' | 'serverless',
  concurrency: number,
  logger: Logger,
): Promise<JobRunner> {
  if (mode === 'serverless') {
    const { waitUntil } = await import('@vercel/functions');
    return new ServerlessRunner(waitUntil, logger);
  }
  return new JobQueue(concurrency, logger);
}
