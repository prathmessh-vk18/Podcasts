/**
 * Produces Vercel's Build Output (v3) for the API: one Node.js function that serves every route,
 * plus a daily cron. Bundling everything into a single file avoids depending on how Vercel
 * resolves our TypeScript workspace packages.
 * Spec: https://vercel.com/docs/build-output-api/v3
 */
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}.vercel/output`;
const fn = `${out}/functions/index.func`;

rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

await build({
  entryPoints: [`${root}src/serverless.ts`],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'linked',
  minify: false,
  // PGlite is only for local development and loads WASM from disk; pino-pretty is dev-only.
  external: ['@electric-sql/pglite', 'pino-pretty'],
  // Some bundled dependencies are CommonJS and call require(); give ESM a require().
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
});

// Ship migrations with the function so DB_AUTO_MIGRATE=true also works (default: migrate at build).
cpSync(`${root}../../packages/db/drizzle`, `${fn}/drizzle`, { recursive: true });

writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      // Background exports continue after the response (waitUntil) up to this limit.
      maxDuration: 300,
    },
    null,
    2,
  ),
);

writeFileSync(
  `${out}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [{ src: '/(.*)', dest: '/index' }],
      // Daily is the most frequent schedule on Vercel's Hobby plan; stalled exports are also
      // resumed whenever a client polls them, so the cron is a safety net.
      crons: [{ path: '/internal/cron', schedule: '0 6 * * *' }],
    },
    null,
    2,
  ),
);

console.log('Vercel build output written to apps/api/.vercel/output');
