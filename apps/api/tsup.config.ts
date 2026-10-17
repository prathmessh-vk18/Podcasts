import { cpSync } from 'node:fs';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // Bundle our workspace packages (they ship TypeScript source); keep npm deps external.
  noExternal: [/^@tangent\//],
  // Libraries the workspace packages depend on stay external: PGlite loads WASM files from its
  // own package directory and breaks if bundled. They're listed in this app's dependencies.
  external: ['@electric-sql/pglite', 'drizzle-orm', 'postgres', 'fast-xml-parser'],
  // Ship the SQL migrations with the bundle; openDb finds them next to main.js.
  onSuccess: async () => {
    cpSync(
      new URL('../../packages/db/drizzle', import.meta.url),
      new URL('./dist/drizzle', import.meta.url),
      { recursive: true },
    );
  },
});
