import { isIP } from 'node:net';
import { ProviderError } from '@tangent/core';

/**
 * Guards server-side fetches of URLs we didn't author (RSS feed URLs) against SSRF.
 * This checks the URL literally; production should also pin the resolved IP
 * (e.g. an egress proxy or a custom DNS lookup) to defeat DNS rebinding.
 */
const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError({
      kind: 'invalid_request',
      platform: 'rss',
      message: 'Feed URL is not a valid URL',
    });
  }
  const fail = (why: string) =>
    new ProviderError({ kind: 'invalid_request', platform: 'rss', message: `Feed URL rejected: ${why}` });
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('only http(s) is allowed');
  if (url.username || url.password) throw fail('credentials in URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  )
    throw fail('local host');
  const ipVersion = isIP(host);
  if (ipVersion === 4 && PRIVATE_V4.some((re) => re.test(host))) throw fail('private address');
  if (
    ipVersion === 6 &&
    (host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe80') ||
      host.startsWith('::ffff:'))
  ) {
    throw fail('private address');
  }
  return url;
}
