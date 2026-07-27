import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Single source of truth: the root package.json, injected as literals.
const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string; author?: string };
const version = pkg.version;
const author = pkg.author ?? '';

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    'process.env.SHOOTS_VERSION': JSON.stringify(version),
    'process.env.SHOOTS_AUTHOR': JSON.stringify(author),
  },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
