import { createHash, randomBytes } from 'node:crypto';

/** Random URL-safe token for OAuth `state` and PKCE verifiers. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** PKCE (RFC 7636) pair. The verifier stays on our server; only the challenge goes to the provider. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48); // 64 chars, within the 43–128 limit
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface TokenSet {
  accessToken: string;
  /** Providers sometimes omit this on refresh; callers must keep the previous one. */
  refreshToken: string | null;
  expiresAt: Date;
  scopes: string[];
}

/** Turn a token-endpoint response into a TokenSet, keeping a previous refresh token if none is returned. */
export function toTokenSet(
  body: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown },
  now: Date,
  previousRefreshToken: string | null = null,
): TokenSet {
  if (typeof body.access_token !== 'string' || !body.access_token)
    throw new Error('Token response had no access_token');
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : previousRefreshToken,
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
    scopes: typeof body.scope === 'string' ? body.scope.split(/[\s,]+/).filter(Boolean) : [],
  };
}
