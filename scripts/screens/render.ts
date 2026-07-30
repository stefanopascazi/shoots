/**
 * Grid of styled cells -> terminal-window SVG -> PNG (sharp/librsvg).
 *
 * Layout is computed in cell units, never measured from the font: every glyph is
 * placed, on its own, centred in its cell. So a machine whose monospace fallback
 * has a different advance width still renders an aligned screen instead of text
 * that drifts out of the grid and collides with the next word.
 */
import sharp from 'sharp';
import { charWidth, PALETTE, type Cell, type Screen, type Style } from './ansi.js';
import { drawGlyph, isGeometric } from './glyphs.js';

export interface Theme {
  fontFamily: string;
  fontSize: number;
  /** Cell advance width. Keep at ~0.55 * fontSize for Consolas/Cascadia. */
  charW: number;
  lineH: number;
  padding: number;
  titleBar: number;
  background: string;
  foreground: string;
  chrome: string;
  border: string;
  radius: number;
  /** Transparent margin left around the window so the shadow is not clipped. */
  margin: number;
}

export const THEME: Theme = {
  fontFamily: "'Cascadia Mono', 'Consolas', 'DejaVu Sans Mono', 'Menlo', monospace",
  fontSize: 15,
  charW: 8.25,
  lineH: 21,
  padding: 18,
  titleBar: 30,
  background: '#171b21',
  foreground: PALETTE.white,
  chrome: '#1e232b',
  border: '#2b313b',
  radius: 10,
  margin: 16,
};

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const isBlank = (cell: Cell) =>
  (cell.ch === ' ' || cell.ch === '') &&
  !cell.style.bg &&
  !cell.style.inverse &&
  !cell.style.underline;

function paint(style: Style, theme: Theme): { fill: string; bg?: string; opacity?: number } {
  let fill = style.fg ?? theme.foreground;
  let bg = style.bg;
  if (style.inverse) {
    const swap = bg ?? theme.background;
    bg = fill;
    fill = swap;
  }
  return { fill, bg, opacity: style.dim ? 0.55 : undefined };
}

export interface ShotOptions {
  /** Window title bar caption. */
  title?: string;
  theme?: Partial<Theme>;
  /** Device-pixel multiplier for the PNG (2 = retina). */
  scale?: number;
}

/** Builds the standalone SVG for a captured screen. */
export function toSvg(screen: Screen, options: ShotOptions = {}): string {
  const theme = { ...THEME, ...options.theme };
  const { charW, lineH, padding, titleBar, margin } = theme;

  const bodyW = screen.cols * charW + padding * 2;
  const bodyH = screen.rows * lineH + padding * 2;
  const winW = bodyW;
  const winH = bodyH + titleBar;
  const width = winW + margin * 2;
  const height = winH + margin * 2;

  const chrome: string[] = [];
  const parts: string[] = [];
  const x0 = margin;
  const y0 = margin;
  const textTop = y0 + titleBar + padding;

  // Cell rects (backgrounds, block glyphs) land on fractional x when charW is
  // not a whole number of device pixels, which shows up as hairline seams
  // between neighbours. Snapping both edges to the output pixel grid makes
  // adjacent cells share one boundary exactly.
  const device = options.scale ?? 2;
  const snap = (v: number) => Math.round(v * device) / device;
  const cellLeft = (col: number) => snap(x0 + padding + col * charW);

  // --- window chrome -------------------------------------------------------
  chrome.push(
    `<rect x="${f(x0)}" y="${f(y0)}" width="${f(winW)}" height="${f(winH)}" rx="${theme.radius}" fill="${theme.background}" stroke="${theme.border}" filter="url(#shadow)"/>`,
    `<path d="M${f(x0)} ${f(y0 + theme.radius)} a${theme.radius} ${theme.radius} 0 0 1 ${theme.radius} -${theme.radius} h${f(winW - theme.radius * 2)} a${theme.radius} ${theme.radius} 0 0 1 ${theme.radius} ${theme.radius} v${f(titleBar - theme.radius)} h-${f(winW)} Z" fill="${theme.chrome}"/>`,
    `<line x1="${f(x0)}" y1="${f(y0 + titleBar)}" x2="${f(x0 + winW)}" y2="${f(y0 + titleBar)}" stroke="${theme.border}"/>`,
  );
  const dots = ['#f2777a', '#f0b429', '#8ec07c'];
  dots.forEach((color, i) => {
    chrome.push(
      `<circle cx="${f(x0 + 16 + i * 15)}" cy="${f(y0 + titleBar / 2)}" r="4.5" fill="${color}" fill-opacity="0.85"/>`,
    );
  });
  if (options.title) {
    chrome.push(
      `<text x="${f(x0 + winW / 2)}" y="${f(y0 + titleBar / 2)}" text-anchor="middle" dominant-baseline="central" font-family="${theme.fontFamily}" font-size="12" fill="${PALETTE.brightBlack}">${esc(options.title)}</text>`,
    );
  }

  // --- cell backgrounds ----------------------------------------------------
  screen.cells.forEach((row, r) => {
    let run: { col: number; len: number; color: string } | null = null;
    const flush = () => {
      if (!run) return;
      const left = cellLeft(run.col);
      parts.push(
        `<rect x="${f(left)}" y="${f(textTop + r * lineH)}" width="${f(cellLeft(run.col + run.len) - left)}" height="${f(lineH)}" fill="${run.color}"/>`,
      );
      run = null;
    };
    row.forEach((cell, col) => {
      const { bg } = paint(cell.style, theme);
      if (!bg) {
        flush();
        return;
      }
      const w = Math.max(1, charWidth(cell.ch || ' '));
      if (run && run.color === bg && run.col + run.len === col) run.len += w;
      else {
        flush();
        run = { col, len: w, color: bg };
      }
    });
    flush();
  });

  // --- glyphs --------------------------------------------------------------
  // One element per cell, centred on the cell. Grouping characters into words
  // would be smaller markup but ties the layout to the renderer's font: a
  // fallback whose advance differs from charW drifts, and long words then
  // collide with the next one. Per-cell placement is exactly what a terminal
  // does, and it is identical on every machine.
  screen.cells.forEach((row, r) => {
    const baseline = textTop + r * lineH + lineH * 0.72;
    row.forEach((cell, col) => {
      if (isBlank(cell)) return;
      const { fill, opacity } = paint(cell.style, theme);
      const cellX = cellLeft(col);
      const cellW = cellLeft(col + Math.max(1, charWidth(cell.ch))) - cellX;

      // Blocks, box drawing and braille are drawn as geometry filling the cell,
      // so they tile with their neighbours exactly as in a terminal.
      if (isGeometric(cell.ch)) {
        const drawn = drawGlyph(
          cell.ch,
          { x: cellX, y: textTop + r * lineH, w: cellW, h: lineH },
          fill,
          cell.style.dim,
        );
        if (drawn) {
          parts.push(drawn);
          return;
        }
      }
      if (cell.ch === ' ' || cell.ch === '') return; // styled-but-empty cell: bg only

      const attrs = [
        `x="${f(cellX + cellW / 2)}"`,
        `y="${f(baseline)}"`,
        `fill="${fill}"`,
        cell.style.bold ? 'font-weight="700"' : '',
        cell.style.italic ? 'font-style="italic"' : '',
        cell.style.underline ? 'text-decoration="underline"' : '',
        opacity !== undefined ? `fill-opacity="${opacity}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      parts.push(`<text ${attrs}>${esc(cell.ch)}</text>`);
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f(width)}" height="${f(height)}" viewBox="0 0 ${f(width)} ${f(height)}">
<defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
<feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#000000" flood-opacity="0.45"/>
</filter></defs>
${chrome.join('\n')}
<g font-family="${theme.fontFamily}" font-size="${theme.fontSize}" text-anchor="middle">
${parts.join('\n')}
</g>
</svg>
`;
}

/** Rasterises a captured screen to PNG at `scale` device pixels per CSS pixel. */
export async function toPng(screen: Screen, options: ShotOptions = {}): Promise<Buffer> {
  const svg = toSvg(screen, options);
  const scale = options.scale ?? 2;
  return sharp(Buffer.from(svg), { density: 72 * scale })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
