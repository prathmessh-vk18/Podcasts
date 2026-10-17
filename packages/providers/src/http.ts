import { ProviderError, type Platform } from '@tangent/core';
import { silentLogger, type Logger } from './logger.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface HttpRequest {
  method?: HttpMethod;
  url: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** JSON body. Mutually exclusive with `form`. */
  json?: unknown;
  /** application/x-www-form-urlencoded body (OAuth token endpoints). */
  form?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Retry transient failures. Defaults to true for GET and false otherwise, because
   * repeating a POST (e.g. "add to playlist") can create duplicates.
   */
  retry?: boolean;
  /** Abort reading if the body exceeds this many bytes (protects against huge feeds). */
  maxBodyBytes?: number;
  responseType?: 'json' | 'text' | 'bytes';
  /** Label for logs, never the URL with secrets. */
  op?: string;
}

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

export interface RawErrorResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body when possible, otherwise null. */
  body: unknown;
  text: string;
}

export type ErrorMapper = (res: RawErrorResponse) => ProviderError;

export interface HttpClientOptions {
  platform: Platform | 'rss';
  mapError: ErrorMapper;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  logger?: Logger;
  defaultTimeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Don't wait longer than this for a Retry-After; fail instead and let the caller decide. */
  maxRetryAfterMs?: number;
  userAgent?: string;
}

const DEFAULT_MAX_BODY = 5 * 1024 * 1024;

/** Retry-After is either delta-seconds or an HTTP date. Returns ms, or undefined if absent/invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.round(Number(trimmed) * 1000));
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function buildUrl(url: string, query?: HttpRequest['query']): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.toString();
}

async function readBody(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Response too large (${declared} bytes)`);
  }
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export class HttpClient {
  private readonly o: Required<Omit<HttpClientOptions, 'logger' | 'userAgent'>> & {
    logger: Logger;
    userAgent: string;
  };

  constructor(opts: HttpClientOptions) {
    this.o = {
      fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: opts.random ?? Math.random,
      now: opts.now ?? Date.now,
      logger: opts.logger ?? silentLogger,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 10_000,
      maxRetries: opts.maxRetries ?? 3,
      baseDelayMs: opts.baseDelayMs ?? 300,
      maxDelayMs: opts.maxDelayMs ?? 8_000,
      maxRetryAfterMs: opts.maxRetryAfterMs ?? 30_000,
      userAgent: opts.userAgent ?? 'TangentBot/0.1 (+https://tangent.fm)',
      platform: opts.platform,
      mapError: opts.mapError,
    };
  }

  async request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>> {
    const method = req.method ?? 'GET';
    const retryAllowed = req.retry ?? method === 'GET';
    const maxAttempts = retryAllowed ? this.o.maxRetries + 1 : 1;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(req, method);
      } catch (err) {
        const pe = this.toProviderError(err, req);
        const last = attempt + 1 >= maxAttempts;
        if (!pe.retryable || last) throw pe;

        let delay: number;
        if (pe.retryAfterMs !== undefined) {
          if (pe.retryAfterMs > this.o.maxRetryAfterMs) throw pe; // too long to block a request; surface it
          delay = pe.retryAfterMs;
        } else {
          // Full jitter: spreads retries from many clients so they don't stampede together.
          delay = Math.round(
            this.o.random() * Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** attempt),
          );
        }
        this.o.logger.warn(
          {
            platform: this.o.platform,
            op: req.op,
            kind: pe.kind,
            status: pe.status,
            attempt: attempt + 1,
            delayMs: delay,
          },
          'retrying provider request',
        );
        await this.o.sleep(delay);
      }
    }
  }

  private async once<T>(req: HttpRequest, method: HttpMethod): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = {
      'user-agent': this.o.userAgent,
      accept: 'application/json',
      ...req.headers,
    };
    let body: string | undefined;
    if (req.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(req.form).toString();
    }

    const started = this.o.now();
    const res = await this.o.fetch(buildUrl(req.url, req.query), {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(req.timeoutMs ?? this.o.defaultTimeoutMs),
      redirect: 'follow',
    });

    const bytes = await readBody(res, req.maxBodyBytes ?? DEFAULT_MAX_BODY);
    this.o.logger.debug(
      {
        platform: this.o.platform,
        op: req.op,
        status: res.status,
        ms: this.o.now() - started,
        bytes: bytes.byteLength,
      },
      'provider response',
    );

    if (!res.ok) {
      const text = new TextDecoder().decode(bytes);
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      throw this.o.mapError({
        status: res.status,
        headers: res.headers,
        body: parsed,
        text: text.slice(0, 2000),
      });
    }

    const type = req.responseType ?? 'json';
    if (type === 'bytes') return { status: res.status, headers: res.headers, data: bytes as T };
    const text = new TextDecoder().decode(bytes);
    if (type === 'text') return { status: res.status, headers: res.headers, data: text as T };
    if (res.status === 204 || text.length === 0)
      return { status: res.status, headers: res.headers, data: null as T };
    try {
      return { status: res.status, headers: res.headers, data: JSON.parse(text) as T };
    } catch (cause) {
      throw new ProviderError({
        kind: 'upstream_unavailable',
        platform: this.o.platform,
        message: 'Provider returned a response that is not valid JSON',
        status: res.status,
        cause,
      });
    }
  }

  private toProviderError(err: unknown, req: HttpRequest): ProviderError {
    if (err instanceof ProviderError) return err;
    const name = (err as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new ProviderError({
        kind: 'timeout',
        platform: this.o.platform,
        message: `Request timed out (${req.op ?? 'request'})`,
        cause: err,
      });
    }
    if (err instanceof Error && /too large|exceeded/.test(err.message)) {
      return new ProviderError({
        kind: 'upstream_unavailable',
        platform: this.o.platform,
        message: err.message,
        cause: err,
      });
    }
    return new ProviderError({
      kind: 'network',
      platform: this.o.platform,
      message: `Network error (${req.op ?? 'request'}): ${(err as Error)?.message ?? 'unknown'}`,
      cause: err,
    });
  }
}

/** Generic status → kind mapping shared by providers; each adapter refines it with its own error format. */
export function baseErrorKind(status: number): ProviderError['kind'] {
  if (status === 401) return 'auth_expired';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_unavailable';
  return 'invalid_request';
}
