import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  // Both SQLite drivers are resolved at runtime from a computed specifier (see
  // db/database.ts); listing them keeps esbuild's resolver away regardless.
  external: ['bun:sqlite', 'node:sqlite'],
});
