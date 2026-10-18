import type { NextConfig } from 'next';

/**
 * The browser only ever talks to this app's own origin. `/api/*` is proxied to the API
 * (another Vercel project in production, localhost in development), so session cookies are
 * first-party and OAuth callbacks land on the same domain.
 */
const API_ORIGIN = (process.env.API_ORIGIN ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
