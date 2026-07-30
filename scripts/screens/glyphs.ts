/**
 * Cell-exact drawing for the glyph families a terminal renders as geometry
 * rather than as type: block elements, box drawing, and braille.
 *
 * Fonts draw these inside their own em box, so at a line height larger than the
 * em they no longer touch — a wordmark made of U+2588 comes out as stripes, and
 * a box border comes out dashed. Drawing them as rects and strokes that span the
 * whole cell reproduces what a terminal actually shows, identically on every
 * machine (no font dependency at all).
 */

export interface CellBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const rect = (box: CellBox, fill: string, opacity?: number) =>
  `<rect x="${f(box.x)}" y="${f(box.y)}" width="${f(box.w)}" height="${f(box.h)}" fill="${fill}"${
    opacity === undefined ? '' : ` fill-opacity="${opacity}"`
  }/>`;

/** Fractional sub-rectangles of a cell, in units of the cell box. */
type Part = [x: number, y: number, w: number, h: number];

/** U+2580..U+259F block elements, as fractions of the cell. */
const BLOCKS: Record<string, { parts: Part[]; opacity?: number }> = {
  '▀': { parts: [[0, 0, 1, 0.5]] }, // ▀ upper half
  '▁': { parts: [[0, 7 / 8, 1, 1 / 8]] }, // ▁
  '▂': { parts: [[0, 0.75, 1, 0.25]] }, // ▂
  '▃': { parts: [[0, 5 / 8, 1, 3 / 8]] }, // ▃
  '▄': { parts: [[0, 0.5, 1, 0.5]] }, // ▄ lower half
  '▅': { parts: [[0, 3 / 8, 1, 5 / 8]] }, // ▅
  '▆': { parts: [[0, 0.25, 1, 0.75]] }, // ▆
  '▇': { parts: [[0, 1 / 8, 1, 7 / 8]] }, // ▇
  '█': { parts: [[0, 0, 1, 1]] }, // █ full
  '▉': { parts: [[0, 0, 7 / 8, 1]] }, // ▉
  '▊': { parts: [[0, 0, 0.75, 1]] }, // ▊
  '▋': { parts: [[0, 0, 5 / 8, 1]] }, // ▋
  '▌': { parts: [[0, 0, 0.5, 1]] }, // ▌ left half
  '▍': { parts: [[0, 0, 3 / 8, 1]] }, // ▍
  '▎': { parts: [[0, 0, 0.25, 1]] }, // ▎
  '▏': { parts: [[0, 0, 1 / 8, 1]] }, // ▏
  '▐': { parts: [[0.5, 0, 0.5, 1]] }, // ▐ right half
  '░': { parts: [[0, 0, 1, 1]], opacity: 0.25 }, // ░
  '▒': { parts: [[0, 0, 1, 1]], opacity: 0.5 }, // ▒
  '▓': { parts: [[0, 0, 1, 1]], opacity: 0.75 }, // ▓
  '▔': { parts: [[0, 0, 1, 1 / 8]] }, // ▔
  '▕': { parts: [[7 / 8, 0, 1 / 8, 1]] }, // ▕
  '▖': { parts: [[0, 0.5, 0.5, 0.5]] }, // ▖
  '▗': { parts: [[0.5, 0.5, 0.5, 0.5]] }, // ▗
  '▘': { parts: [[0, 0, 0.5, 0.5]] }, // ▘
  '▙': { parts: [[0, 0, 0.5, 1], [0, 0.5, 1, 0.5]] }, // ▙
  '▚': { parts: [[0, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]] }, // ▚
  '▛': { parts: [[0, 0, 1, 0.5], [0, 0, 0.5, 1]] }, // ▛
  '▜': { parts: [[0, 0, 1, 0.5], [0.5, 0, 0.5, 1]] }, // ▜
  '▝': { parts: [[0.5, 0, 0.5, 0.5]] }, // ▝
  '▞': { parts: [[0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5]] }, // ▞
  '▟': { parts: [[0.5, 0, 0.5, 1], [0, 0.5, 1, 0.5]] }, // ▟
};

/**
 * Box drawing as four arms from the cell centre. Each arm is a weight:
 * 0 none, 1 light, 2 heavy, 3 double. `r` rounds the corners (U+256D..U+2570).
 */
interface BoxSpec {
  up?: number;
  down?: number;
  left?: number;
  right?: number;
  rounded?: boolean;
}

const BOX: Record<string, BoxSpec> = {
  '─': { left: 1, right: 1 }, // ─
  '━': { left: 2, right: 2 }, // ━
  '│': { up: 1, down: 1 }, // │
  '┃': { up: 2, down: 2 }, // ┃
  '┌': { down: 1, right: 1 }, // ┌
  '┏': { down: 2, right: 2 }, // ┏
  '┐': { down: 1, left: 1 }, // ┐
  '┓': { down: 2, left: 2 }, // ┓
  '└': { up: 1, right: 1 }, // └
  '┗': { up: 2, right: 2 }, // ┗
  '┘': { up: 1, left: 1 }, // ┘
  '┛': { up: 2, left: 2 }, // ┛
  '├': { up: 1, down: 1, right: 1 }, // ├
  '┤': { up: 1, down: 1, left: 1 }, // ┤
  '┬': { down: 1, left: 1, right: 1 }, // ┬
  '┴': { up: 1, left: 1, right: 1 }, // ┴
  '┼': { up: 1, down: 1, left: 1, right: 1 }, // ┼
  '╭': { down: 1, right: 1, rounded: true }, // ╭
  '╮': { down: 1, left: 1, rounded: true }, // ╮
  '╯': { up: 1, left: 1, rounded: true }, // ╯
  '╰': { up: 1, right: 1, rounded: true }, // ╰
  '═': { left: 3, right: 3 }, // ═
  '║': { up: 3, down: 3 }, // ║
  '╒': { down: 1, right: 3 }, // ╒
  '╓': { down: 3, right: 1 }, // ╓
  '╔': { down: 3, right: 3 }, // ╔
  '╕': { down: 1, left: 3 }, // ╕
  '╖': { down: 3, left: 1 }, // ╖
  '╗': { down: 3, left: 3 }, // ╗
  '╘': { up: 1, right: 3 }, // ╘
  '╙': { up: 3, right: 1 }, // ╙
  '╚': { up: 3, right: 3 }, // ╚
  '╛': { up: 1, left: 3 }, // ╛
  '╜': { up: 3, left: 1 }, // ╜
  '╝': { up: 3, left: 3 }, // ╝
  '╞': { up: 1, down: 1, right: 3 }, // ╞
  '╟': { up: 3, down: 3, right: 1 }, // ╟
  '╠': { up: 3, down: 3, right: 3 }, // ╠
  '╡': { up: 1, down: 1, left: 3 }, // ╡
  '╢': { up: 3, down: 3, left: 1 }, // ╢
  '╣': { up: 3, down: 3, left: 3 }, // ╣
  '╤': { down: 1, left: 3, right: 3 }, // ╤
  '╥': { down: 3, left: 1, right: 1 }, // ╥
  '╦': { down: 3, left: 3, right: 3 }, // ╦
  '╧': { up: 1, left: 3, right: 3 }, // ╧
  '╨': { up: 3, left: 1, right: 1 }, // ╨
  '╩': { up: 3, left: 3, right: 3 }, // ╩
  '╪': { up: 1, down: 1, left: 3, right: 3 }, // ╪
  '╫': { up: 3, down: 3, left: 1, right: 1 }, // ╫
  '╬': { up: 3, down: 3, left: 3, right: 3 }, // ╬
};

/** Dashed horizontals/verticals: drawn solid — at this size the dashes vanish. */
const DASHED: Record<string, BoxSpec> = {
  '┄': { left: 1, right: 1 },
  '┅': { left: 2, right: 2 },
  '┈': { left: 1, right: 1 },
  '┉': { left: 2, right: 2 },
  '┆': { up: 1, down: 1 },
  '┇': { up: 2, down: 2 },
  '┊': { up: 1, down: 1 },
  '┋': { up: 2, down: 2 },
};

/** Braille dot layout: bit index -> [column, row] in the 2x4 dot grid. */
const BRAILLE_DOTS: [number, number][] = [
  [0, 0],
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 1],
  [1, 2],
  [0, 3],
  [1, 3],
];

/**
 * Check and cross marks. Consolas has neither, and the substitute a fallback
 * font supplies is usually a radical sign or a multiplication x — wrong enough
 * to misread a status line. Drawn as strokes instead.
 */
const MARKS = new Set(['✓', '✔', '✗', '✘']);

export function isGeometric(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x2580 && cp <= 0x259f) return BLOCKS[ch] !== undefined;
  if (cp >= 0x2500 && cp <= 0x257f) return BOX[ch] !== undefined || DASHED[ch] !== undefined;
  if (MARKS.has(ch)) return true;
  return cp >= 0x2800 && cp <= 0x28ff;
}

/**
 * SVG for one geometric glyph filling `box`, or null if we do not draw it as
 * geometry (the caller then falls back to text).
 */
export function drawGlyph(ch: string, box: CellBox, color: string, dim?: boolean): string | null {
  const cp = ch.codePointAt(0) ?? 0;
  const alpha = dim ? 0.55 : undefined;

  const block = BLOCKS[ch];
  if (block) {
    const opacity =
      block.opacity === undefined ? alpha : block.opacity * (dim ? 0.55 : 1);
    return block.parts
      .map(([x, y, w, h]) =>
        rect(
          { x: box.x + x * box.w, y: box.y + y * box.h, w: w * box.w, h: h * box.h },
          color,
          opacity,
        ),
      )
      .join('');
  }

  const spec = BOX[ch] ?? DASHED[ch];
  if (spec) return drawBox(spec, box, color, alpha);

  if (MARKS.has(ch)) {
    const w = Math.max(1.2, box.w * 0.16);
    const stroke = `stroke="${color}" stroke-width="${f(w)}" stroke-linecap="round" fill="none"${
      alpha === undefined ? '' : ` stroke-opacity="${alpha}"`
    }`;
    const [l, r, t, b] = [box.x + box.w * 0.16, box.x + box.w * 0.84, box.y + box.h * 0.3, box.y + box.h * 0.72];
    if (ch === '✓' || ch === '✔') {
      const mid = box.x + box.w * 0.4;
      return `<path d="M${f(l)} ${f(box.y + box.h * 0.52)} L${f(mid)} ${f(b)} L${f(r)} ${f(t)}" ${stroke}/>`;
    }
    return `<path d="M${f(l)} ${f(t)} L${f(r)} ${f(b)} M${f(r)} ${f(t)} L${f(l)} ${f(b)}" ${stroke}/>`;
  }

  if (cp >= 0x2800 && cp <= 0x28ff) {
    const bits = cp - 0x2800;
    const r = Math.min(box.w, box.h) * 0.09;
    const dots: string[] = [];
    BRAILLE_DOTS.forEach(([col, row], i) => {
      if ((bits & (1 << i)) === 0) return;
      const cx = box.x + box.w * (col === 0 ? 0.32 : 0.68);
      const cy = box.y + box.h * (0.18 + row * 0.215);
      dots.push(
        `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${color}"${
          alpha === undefined ? '' : ` fill-opacity="${alpha}"`
        }/>`,
      );
    });
    return dots.join('');
  }

  return null;
}

/**
 * Arms are drawn to the cell edge so neighbours join seamlessly. Double lines
 * are two thin strokes offset around the centre; heavy is a thicker single one.
 */
function drawBox(spec: BoxSpec, box: CellBox, color: string, alpha?: number): string {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const light = Math.max(1, Math.round(box.w * 0.13));
  const heavy = light * 2;
  const gap = light * 1.6;
  const opacity = alpha === undefined ? '' : ` fill-opacity="${alpha}"`;
  const out: string[] = [];

  const hBar = (from: number, to: number, y: number, thickness: number) =>
    out.push(
      `<rect x="${f(Math.min(from, to))}" y="${f(y - thickness / 2)}" width="${f(Math.abs(to - from))}" height="${f(thickness)}" fill="${color}"${opacity}/>`,
    );
  const vBar = (from: number, to: number, x: number, thickness: number) =>
    out.push(
      `<rect x="${f(x - thickness / 2)}" y="${f(Math.min(from, to))}" width="${f(thickness)}" height="${f(Math.abs(to - from))}" fill="${color}"${opacity}/>`,
    );

  const arm = (side: 'up' | 'down' | 'left' | 'right', weight: number) => {
    if (!weight) return;
    const horizontal = side === 'left' || side === 'right';
    const edge =
      side === 'up' ? box.y : side === 'down' ? box.y + box.h : side === 'left' ? box.x : box.x + box.w;
    const thickness = weight === 2 ? heavy : light;

    if (weight === 3) {
      // Double: the two rails stop at the far rail of the crossing axis so
      // corners close instead of overshooting.
      const crossing = horizontal
        ? (spec.up === 3 || spec.down === 3 ? gap / 2 + light / 2 : 0)
        : (spec.left === 3 || spec.right === 3 ? gap / 2 + light / 2 : 0);
      const stop = horizontal
        ? side === 'left'
          ? cx + crossing
          : cx - crossing
        : side === 'up'
          ? cy + crossing
          : cy - crossing;
      for (const offset of [-gap / 2, gap / 2]) {
        if (horizontal) hBar(edge, stop, cy + offset, light);
        else vBar(edge, stop, cx + offset, light);
      }
      return;
    }
    if (horizontal) hBar(edge, cx, cy, thickness);
    else vBar(edge, cy, cx, thickness);
  };

  if (spec.rounded) {
    // Quarter arc joining the two arms, with the arms trimmed to its ends.
    const radius = Math.min(box.w, box.h) * 0.45;
    const sx = spec.left ? cx - radius : cx + radius;
    const sy = spec.up ? cy - radius : cy + radius;
    const sweep = (spec.down && spec.right) || (spec.up && spec.left) ? 0 : 1;
    out.push(
      `<path d="M${f(sx)} ${f(cy)} A${f(radius)} ${f(radius)} 0 0 ${sweep} ${f(cx)} ${f(sy)}" fill="none" stroke="${color}" stroke-width="${f(light)}"${alpha === undefined ? '' : ` stroke-opacity="${alpha}"`}/>`,
    );
    if (spec.left) hBar(box.x, cx - radius, cy, light);
    if (spec.right) hBar(box.x + box.w, cx + radius, cy, light);
    if (spec.up) vBar(box.y, cy - radius, cx, light);
    if (spec.down) vBar(box.y + box.h, cy + radius, cx, light);
    return out.join('');
  }

  arm('up', spec.up ?? 0);
  arm('down', spec.down ?? 0);
  arm('left', spec.left ?? 0);
  arm('right', spec.right ?? 0);
  return out.join('');
}
