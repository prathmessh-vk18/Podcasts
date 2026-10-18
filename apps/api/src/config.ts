import { z } from 'zod';

/**
 * All configuration comes from environment variables, validated once at boot.
 * Production refuses to start without its secrets; development fills in safe local defaults.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    /** Public URL of this API (used for OAuth redirect URIs). */
    PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
    /** The web app's origin: allowed for CORS and used for post-OAuth redirects. */
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

    DATABASE_URL: z.string().url().optional(),
    PGLITE_DIR: z.string().default('.data/pglite'),

    SESSION_SECRET: z.string().min(32).optional(),
    /** Base64-encoded 32-byte key for AES-256-GCM token encryption. */
    TOKEN_ENCRYPTION_KEY: z.string().optional(),
    /** Comma-separated previous keys, accepted for decryption during rotation. */
    TOKEN_ENCRYPTION_KEYS_OLD: z.string().optional(),

    APPLE_COUNTRY: z.string().length(2).default('us'),

    SPOTIFY_CLIENT_ID: z.string().optional(),
    SPOTIFY_CLIENT_SECRET: z.string().optional(),
    SPOTIFY_MARKET: z.string().length(2).default('US'),

    YOUTUBE_API_KEY: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    YOUTUBE_REGION: z.string().length(2).default('US'),
    YOUTUBE_DAILY_QUOTA: z.coerce.number().int().positive().default(10_000),

    /** Where the API runs. Auto-detected on Vercel; override for tests. */
    RUNTIME: z.enum(['server', 'serverless']).optional(),
    /** Bearer secret Vercel Cron sends to /internal/cron. Required for the cron endpoint to work. */
    CRON_SECRET: z.string().min(16).optional(),
    /** Run migrations when the app opens the database. Off on serverless: migrations run at build time. */
    DB_AUTO_MIGRATE: z.enum(['true', 'false']).optional(),

    MATCH_CACHE_DAYS: z.coerce.number().positive().default(7),
    /** Max export jobs processed at once by this instance. */
    JOB_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (!env.SESSION_SECRET)
      ctx.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'required in production' });
    if (!env.TOKEN_ENCRYPTION_KEY)
      ctx.addIssue({ code: 'custom', path: ['TOKEN_ENCRYPTION_KEY'], message: 'required in production' });
    if (!env.DATABASE_URL)
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'required in production (PGlite is for local use)',
      });
    if (!env.PUBLIC_API_URL.startsWith('https://'))
      ctx.addIssue({ code: 'custom', path: ['PUBLIC_API_URL'], message: 'must be https in production' });
  });

export type Env = z.infer<typeof schema>;

export interface Config extends Env {
  runtime: 'server' | 'serverless';
  autoMigrate: boolean;
  sessionSecret: string;
  encryptionKeys: { current: Buffer; old: Buffer[] };
  isProd: boolean;
  warnings: string[];
}

function decodeKey(name: string, value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be base64 for exactly 32 bytes (got ${key.length})`);
  return key;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in a .env file means "not set" (the template ships with empty lines), not an empty value.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  const env = parsed.data;
  const warnings: string[] = [];

  // Fixed development fallbacks: stable across restarts, obviously unsafe, never used in production.
  const sessionSecret = env.SESSION_SECRET ?? 'dev-only-session-secret-do-not-use-in-production!!';
  if (!env.SESSION_SECRET) warnings.push('SESSION_SECRET not set: using a development secret');

  let current: Buffer;
  if (env.TOKEN_ENCRYPTION_KEY) current = decodeKey('TOKEN_ENCRYPTION_KEY', env.TOKEN_ENCRYPTION_KEY);
  else {
    current = Buffer.from('dev-only-token-key-32-bytes-long', 'utf8');
    warnings.push('TOKEN_ENCRYPTION_KEY not set: using a development key');
  }
  const old = (env.TOKEN_ENCRYPTION_KEYS_OLD ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((k, i) => decodeKey(`TOKEN_ENCRYPTION_KEYS_OLD[${i}]`, k));

  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET)
    warnings.push('Spotify is disabled: SPOTIFY_CLIENT_ID/SECRET not set');
  if (!env.YOUTUBE_API_KEY) warnings.push('YouTube is disabled: YOUTUBE_API_KEY not set');
  else if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    warnings.push('YouTube export is disabled: GOOGLE_CLIENT_ID/SECRET not set');

  const runtime = env.RUNTIME ?? (source.VERCEL ? 'serverless' : 'server');
  const autoMigrate = env.DB_AUTO_MIGRATE ? env.DB_AUTO_MIGRATE === 'true' : runtime === 'server';
  if (runtime === 'serverless' && !env.CRON_SECRET)
    warnings.push('CRON_SECRET not set: the cron endpoint is disabled');

  return {
    ...env,
    runtime,
    autoMigrate,
    sessionSecret,
    encryptionKeys: { current, old },
    isProd: env.NODE_ENV === 'production',
    warnings,
  };
}
