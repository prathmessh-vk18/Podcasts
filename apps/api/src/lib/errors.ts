import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { DomainError, ProviderError, type DomainErrorCode, type ProviderErrorKind } from '@tangent/core';

/**
 * Every error response has the same shape:
 *   { error: { code, message, retryable, details? } }
 * Provider and internal details are logged, never sent to the client.
 */
export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; details?: unknown };
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  quota_insufficient: 429,
};

const PROVIDER: Record<ProviderErrorKind, { status: number; code: string; message?: string }> = {
  rate_limited: {
    status: 503,
    code: 'provider_busy',
    message: 'The provider is rate limiting us. Try again shortly.',
  },
  quota_exceeded: { status: 429, code: 'provider_quota_exceeded' },
  auth_expired: {
    status: 409,
    code: 'reconnect_required',
    message: 'Your connection expired. Please reconnect.',
  },
  auth_revoked: {
    status: 409,
    code: 'reconnect_required',
    message: 'Access was revoked. Please reconnect your account.',
  },
  not_allowlisted: {
    status: 403,
    code: 'provider_not_allowlisted',
    message:
      'This app is in limited testing on this platform and your account is not on the tester list yet.',
  },
  forbidden: { status: 403, code: 'provider_forbidden' },
  not_found: { status: 404, code: 'provider_not_found', message: 'The provider could not find that item.' },
  unavailable_in_market: {
    status: 404,
    code: 'unavailable_in_region',
    message: 'That item is not available in your region.',
  },
  invalid_request: { status: 502, code: 'provider_rejected', message: 'The provider rejected the request.' },
  upstream_unavailable: {
    status: 502,
    code: 'provider_unavailable',
    message: 'The provider is having problems. Try again later.',
  },
  timeout: { status: 504, code: 'provider_timeout', message: 'The provider took too long to respond.' },
  network: { status: 502, code: 'provider_unreachable', message: 'We could not reach the provider.' },
  unsupported: { status: 400, code: 'unsupported', message: 'That platform does not support this action.' },
  not_configured: {
    status: 503,
    code: 'provider_not_configured',
    message: 'That platform is not enabled on this server.',
  },
};

export function toErrorResponse(err: unknown): {
  status: number;
  body: ErrorBody;
  headers?: Record<string, string>;
} {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: 'validation',
          message: 'Some fields are invalid',
          retryable: false,
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      },
    };
  }
  if (err instanceof DomainError) {
    return {
      status: DOMAIN_STATUS[err.code],
      body: { error: { code: err.code, message: err.message, retryable: false, details: err.details } },
    };
  }
  if (err instanceof ProviderError) {
    const m = PROVIDER[err.kind];
    const headers = err.retryAfterMs
      ? { 'retry-after': String(Math.ceil(err.retryAfterMs / 1000)) }
      : undefined;
    // Forbidden/quota messages from our own adapters are written for users; others are generic.
    const own = err.kind === 'forbidden' || err.kind === 'quota_exceeded' || err.kind === 'unsupported';
    return {
      status: m.status,
      headers,
      body: {
        error: {
          code: m.code,
          message: own ? err.message : (m.message ?? err.message),
          retryable: err.retryable,
          details: { platform: err.platform },
        },
      },
    };
  }
  const fe = err as FastifyError;
  if (fe?.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    const code =
      fe.statusCode === 429
        ? 'rate_limited'
        : fe.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
          ? 'payload_too_large'
          : 'bad_request';
    return {
      status: fe.statusCode,
      body: { error: { code, message: fe.message, retryable: fe.statusCode === 429 } },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'internal', message: 'Something went wrong on our side.', retryable: true } },
  };
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply): void {
  const { status, body, headers } = toErrorResponse(err);
  const level = status >= 500 ? 'error' : 'warn';
  req.log[level](
    {
      err:
        err instanceof Error
          ? { name: err.name, message: err.message, ...(status >= 500 ? { stack: err.stack } : {}) }
          : err,
      kind: err instanceof ProviderError ? err.kind : undefined,
      reason: err instanceof ProviderError ? err.reason : undefined,
      status,
    },
    'request failed',
  );
  if (headers) void reply.headers(headers);
  void reply.status(status).send(body);
}
