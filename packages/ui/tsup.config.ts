import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'neutral',
  external: ['preact', 'preact/hooks', 'preact/jsx-runtime'],
  // Stylesheets are imported as strings so a single-binary server can inline them.
  loader: { '.css': 'text' },
  // Also emit the plain stylesheet for apps that link CSS instead of inlining it.
  async onSuccess() {
    const built = `${pathToFileURL(resolve('dist/index.js')).href}?t=${Date.now()}`;
    const { UI_CSS } = (await import(built)) as { UI_CSS: string };
    writeFileSync('dist/shoots-ui.css', UI_CSS);
  },
});
