import type { Platform } from './types.js';

/**
 * One error vocabulary for the whole system. Providers translate their own failures into
 * these kinds so the export engine and API can react without knowing provider details.
 */
export type ProviderErrorKind =
  /** Too many requests right now. Retry after `retryAfterMs`. */
  | 'rate_limited'
  /** Daily or per-app allowance used up. Retrying before the reset is pointless. */
  | 'quota_exceeded'
  /** Access token expired. Refresh and retry once. */
  | 'auth_expired'
  /** The user revoked access or the refresh token is invalid. They must reconnect. */
  | 'auth_revoked'
  /** The app is in a restricted mode and this user isn't allowed (e.g. Spotify dev-mode allowlist). */
  | 'not_allowlisted'
  /** Missing scope or otherwise not permitted. */
  | 'forbidden'
  | 'not_found'
  /** The item exists but isn't playable in this market or region. */
  | 'unavailable_in_market'
  /** Our request was malformed. A bug, or invalid input that reached the provider. */
  | 'invalid_request'
  /** The provider returned 5xx or garbage. */
  | 'upstream_unavailable'
  | 'timeout'
  | 'network'
  /** The provider can't do this at all (e.g. Apple has no playlist API). */
  | 'unsupported'
  /** The provider isn't configured on this server (missing credentials). */
  | 'not_configured';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limited',
  'upstream_unavailable',
  'timeout',
  'network',
]);

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly platform: Platform | 'rss';
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  /** Provider-specific reason string (e.g. YouTube `quotaExceeded`), for logs only. */
  readonly reason: string | undefined;

  constructor(opts: {
    kind: ProviderErrorKind;
    platform: Platform | 'rss';
    message: string;
    status?: number;
    retryAfterMs?: number;
    reason?: string;
    cause?: unknown;
  }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = opts.kind;
    this.platform = opts.platform;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.reason = opts.reason;
  }

  /** Transient failures worth retrying automatically. Auth expiry is handled separately (refresh). */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/** Errors that come from our own rules rather than a provider. Mapped to 4xx by the API. */
export type DomainErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'quota_insufficient';

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: DomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}
