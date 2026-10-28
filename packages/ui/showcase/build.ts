/**
 * Builds the design-system showcase into one self-contained HTML file:
 * `packages/ui/dist/showcase.html`. Same shape the local web app will use —
 * stylesheet and Preact bundle inlined, no network.
 *
 *   bun packages/ui/showcase/build.ts
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_CSS } from '../src/css.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'dist', 'showcase.html');

const bundle = await build({
  entryPoints: [path.join(here, 'client.tsx')],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
});

const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = UI_CSS + readFileSync(path.join(here, 'showcase.css'), 'utf8');

// Applied before first paint so a stored theme never flashes the other one.
const themeBoot = `try{var t=localStorage.getItem('sh-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shoots design system</title>
<script>${themeBoot}</script>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${path.relative(process.cwd(), out)}  ${(html.length / 1024).toFixed(1)} KB`);
