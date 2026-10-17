import { DomainError, ProviderError, type Platform } from '@tangent/core';
import type { AccountRow, Repos } from '@tangent/db';
import { createPkcePair, randomToken, type Logger, type TokenSet } from '@tangent/providers';
import type { Config } from '../config.js';
import type { TokenCipher } from '../lib/crypto.js';
import type { ProviderRegistry } from './registry.js';

const STATE_TTL_MS = 10 * 60_000;
/** Refresh a little early so a token doesn't expire in the middle of a request. */
const REFRESH_SKEW_MS = 2 * 60_000;

export interface ConnectionView {
  platform: Platform;
  connected: boolean;
  status: 'active' | 'needs_reauth' | 'not_connected';
  displayName: string | null;
  available: boolean;
}

/** Only same-site relative paths; blocks open redirects like "//evil.com" or "https://evil.com". */
export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.length > 500
  )
    return '/';
  return value;
}

export class ConnectionService {
  /** One refresh per account at a time; concurrent callers share the result. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly registry: ProviderRegistry,
    private readonly cipher: TokenCipher,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private aad(userId: string, platform: Platform): string {
    return `${userId}:${platform}`;
  }

  redirectUri(platform: Platform): string {
    return `${this.config.PUBLIC_API_URL.replace(/\/$/, '')}/v1/connections/${platform}/callback`;
  }

  async list(userId: string): Promise<ConnectionView[]> {
    const rows = await this.repos.accounts.listForUser(userId);
    return (['spotify', 'youtube'] as const).map((platform) => {
      const row = rows.find((r) => r.platform === platform);
      return {
        platform,
        connected: !!row && row.status === 'active',
        status: row ? row.status : 'not_connected',
        displayName: row?.displayName ?? null,
        available: !!this.registry.oauth[platform],
      };
    });
  }

  /** Step 1: create single-use state + PKCE verifier and return the provider's consent URL. */
  async start(userId: string, platform: Platform, returnTo: unknown): Promise<string> {
    const provider = this.registry.oauthFor(platform);
    const state = randomToken(24);
    const { verifier, challenge } = createPkcePair();
    await this.repos.oauthStates.create({
      state,
      userId,
      platform,
      codeVerifier: verifier,
      returnTo: safeReturnTo(returnTo),
      expiresAt: new Date(this.now().getTime() + STATE_TTL_MS),
    });
    return provider.buildAuthorizeUrl({
      state,
      codeChallenge: challenge,
      redirectUri: this.redirectUri(platform),
    });
  }

  /**
   * Step 2: the provider redirected back. Validate state (CSRF + replay), exchange the code,
   * fetch the account, store encrypted tokens. Returns where to send the browser.
   */
  async callback(
    userId: string,
    platform: Platform,
    query: { code?: string; state?: string; error?: string },
  ): Promise<{ returnTo: string; outcome: string }> {
    if (!query.state) return { returnTo: '/', outcome: 'invalid_state' };
    const stored = await this.repos.oauthStates.consume(query.state, userId, this.now());
    if (!stored || stored.platform !== platform) return { returnTo: '/', outcome: 'invalid_state' };
    const returnTo = stored.returnTo ?? '/';

    if (query.error)
      return { returnTo, outcome: query.error === 'access_denied' ? 'denied' : 'provider_error' };
    if (!query.code) return { returnTo, outcome: 'provider_error' };

    const provider = this.registry.oauthFor(platform);
    try {
      const tokens = await provider.exchangeCode({
        code: query.code,
        codeVerifier: stored.codeVerifier,
        redirectUri: this.redirectUri(platform),
      });
      const account = await provider.getAccount(tokens.accessToken);
      await this.repos.accounts.upsert({
        userId,
        platform,
        externalId: account.externalId,
        displayName: account.displayName,
        ...this.encryptTokens(userId, platform, tokens),
      });
      return { returnTo, outcome: 'connected' };
    } catch (err) {
      this.logger.warn(
        { platform, kind: (err as ProviderError)?.kind, reason: (err as ProviderError)?.reason },
        'oauth callback failed',
      );
      if (err instanceof ProviderError) {
        if (err.kind === 'not_allowlisted') return { returnTo, outcome: 'not_allowlisted' };
        if (err.kind === 'forbidden')
          return { returnTo, outcome: err.reason === 'noChannel' ? 'no_channel' : 'missing_permission' };
      }
      return { returnTo, outcome: 'error' };
    }
  }

  private encryptTokens(userId: string, platform: Platform, t: TokenSet) {
    const aad = this.aad(userId, platform);
    return {
      accessTokenEnc: this.cipher.encrypt(t.accessToken, aad),
      refreshTokenEnc: t.refreshToken ? this.cipher.encrypt(t.refreshToken, aad) : null,
      expiresAt: t.expiresAt,
      scopes: t.scopes,
    };
  }

  async disconnect(userId: string, platform: Platform): Promise<void> {
    const row = await this.repos.accounts.delete(userId, platform);
    if (!row) return;
    // Revoke after deleting locally: even if the provider call fails, we no longer hold the token.
    try {
      const token = row.refreshTokenEnc ?? row.accessTokenEnc;
      await this.registry.oauth[platform]?.revoke(this.cipher.decrypt(token, this.aad(userId, platform)));
    } catch (err) {
      this.logger.warn(
        { platform, err: (err as Error).message },
        'token revoke failed (local tokens already deleted)',
      );
    }
  }

  /**
   * A usable access token, refreshing if it's about to expire.
   * Throws ProviderError(auth_revoked) when the user must reconnect.
   */
  async getAccessToken(
    userId: string,
    platform: Platform,
    opts: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    const row = await this.repos.accounts.get(userId, platform);
    if (!row)
      throw new DomainError('invalid_state', `Connect your ${platform} account first`, {
        platform,
        reconnect: true,
      });
    if (row.status === 'needs_reauth') {
      throw new ProviderError({
        kind: 'auth_revoked',
        platform,
        message: `Your ${platform} connection needs to be renewed`,
      });
    }
    const aad = this.aad(userId, platform);
    if (!opts.forceRefresh && row.expiresAt.getTime() - REFRESH_SKEW_MS > this.now().getTime()) {
      return this.cipher.decrypt(row.accessTokenEnc, aad);
    }
    const inflight = this.refreshing.get(row.id);
    if (inflight) return inflight;
    const p = this.refresh(row, aad).finally(() => this.refreshing.delete(row.id));
    this.refreshing.set(row.id, p);
    return p;
  }

  private async refresh(row: AccountRow, aad: string): Promise<string> {
    if (!row.refreshTokenEnc) {
      await this.repos.accounts.markNeedsReauth(row.id);
      throw new ProviderError({
        kind: 'auth_revoked',
        platform: row.platform,
        message: 'No refresh token; please reconnect',
      });
    }
    const provider = this.registry.oauthFor(row.platform);
    try {
      const tokens = await provider.refresh(this.cipher.decrypt(row.refreshTokenEnc, aad));
      const enc = this.encryptTokens(row.userId, row.platform, tokens);
      await this.repos.accounts.updateTokens(row.id, enc);
      return tokens.accessToken;
    } catch (err) {
      if (
        err instanceof ProviderError &&
        (err.kind === 'auth_revoked' || err.kind === 'invalid_request' || err.kind === 'forbidden')
      ) {
        await this.repos.accounts.markNeedsReauth(row.id);
        throw new ProviderError({
          kind: 'auth_revoked',
          platform: row.platform,
          message: 'Access was revoked; please reconnect',
          cause: err,
        });
      }
      throw err; // transient: leave the account active and let the caller retry
    }
  }
}
