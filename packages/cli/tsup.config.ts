import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/cli.tsx' },
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node18',
  platform: 'node',
  banner: { js: '#!/usr/bin/env node' },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
