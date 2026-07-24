import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

// Single source of truth: the root package.json version, injected as a literal.
const version = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node18',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  define: { 'process.env.SHOOTS_VERSION': JSON.stringify(version) },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
