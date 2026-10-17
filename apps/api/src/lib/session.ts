import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DomainError } from '@tangent/core';
import type { Repos } from '@tangent/db';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

export const SESSION_COOKIE = 'tg_sid';
const ONE_YEAR_S = 365 * 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step-1 identity: an anonymous user per browser, held in a signed, httpOnly cookie.
 * Real sign-in (email or social login) plugs in here later without changing routes,
 * because everything downstream only reads `request.userId`.
 *
 * CSRF: cookie-authenticated writes must carry the `x-tangent-csrf` header. Browsers only send
 * custom headers cross-origin after a CORS preflight, which we only allow for WEB_ORIGIN.
 */
export function registerSession(app: FastifyInstance, repos: Repos, opts: { secure: boolean }): void {
  app.decorateRequest('userId', '');

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/v1/')) return;

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-tangent-csrf'] !== '1') {
      throw new DomainError('forbidden', 'Missing CSRF header');
    }

    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (
        unsigned.valid &&
        unsigned.value &&
        UUID.test(unsigned.value) &&
        (await repos.users.exists(unsigned.value))
      ) {
        req.userId = unsigned.value;
        return;
      }
    }
    // OAuth callbacks must come back to the same user that started the flow.
    if (req.url.includes('/callback'))
      throw new DomainError(
        'unauthenticated',
        'Session expired during sign-in. Please try connecting again.',
      );

    req.userId = await repos.users.create();
    void reply.setCookie(SESSION_COOKIE, req.userId, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax', // sent on the top-level redirect back from OAuth providers
      secure: opts.secure,
      path: '/',
      maxAge: ONE_YEAR_S,
    });
  });
}
