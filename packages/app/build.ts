/**
 * Builds the client into one self-contained page, `dist/app.html`: the design
 * system's stylesheet and the Preact bundle inlined, nothing fetched from the
 * network. `shoots app` serves this string.
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_CSS } from '@shoots/ui';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'dist', 'app.html');
const APP_CSS = readFileSync(path.join(here, 'src', 'app.css'), 'utf8');

const bundle = await build({
  entryPoints: [path.join(here, 'src', 'main.tsx')],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  legalComments: 'none',
});

const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\/script');
// Applied before first paint so a stored theme never flashes the other one.
const themeBoot = `try{var t=localStorage.getItem('sh-theme');if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>shoots</title>
<script>${themeBoot}</script>
<style>${UI_CSS}${APP_CSS}</style>
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

// The module the server imports: the page as one string.
writeFileSync(path.join(here, 'dist', 'index.js'), `export const APP_HTML = ${JSON.stringify(html)};\n`);
