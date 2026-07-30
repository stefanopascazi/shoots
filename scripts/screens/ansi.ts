/**
 * Minimal terminal emulator: ANSI byte stream -> grid of styled cells.
 *
 * Just enough of VT100/xterm to replay what our own Ink UIs and Commander
 * output actually emit: full-frame repaints (ED/CUP), SGR colour + intensity,
 * and the cursor moves log-update uses between frames. Anything we never emit
 * (scroll regions, tabs, charset switching) is skipped rather than guessed.
 */

export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface Cell {
  ch: string;
  style: Style;
}

/** 16 ANSI slots, warmed slightly to sit next to the brand amber. */
export const PALETTE = {
  black: '#171b21',
  red: '#f2777a',
  green: '#8ec07c',
  yellow: '#f0b429',
  blue: '#7aa2f7',
  magenta: '#c084fc',
  cyan: '#67e8f9',
  white: '#c8ccd4',
  brightBlack: '#5a6270',
  brightRed: '#ff8a8d',
  brightGreen: '#a9dc8a',
  brightYellow: '#ffd479',
  brightBlue: '#9ab8ff',
  brightMagenta: '#d8b4fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#f2f4f8',
} as const;

const BASIC = [
  PALETTE.black,
  PALETTE.red,
  PALETTE.green,
  PALETTE.yellow,
  PALETTE.blue,
  PALETTE.magenta,
  PALETTE.cyan,
  PALETTE.white,
];
const BRIGHT = [
  PALETTE.brightBlack,
  PALETTE.brightRed,
  PALETTE.brightGreen,
  PALETTE.brightYellow,
  PALETTE.brightBlue,
  PALETTE.brightMagenta,
  PALETTE.brightCyan,
  PALETTE.brightWhite,
];

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;

/** xterm 256-colour cube -> hex. 0-15 reuse the palette above. */
function xterm256(n: number): string {
  if (n < 8) return BASIC[n]!;
  if (n < 16) return BRIGHT[n - 8]!;
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    return hex(steps[Math.floor(i / 36)]!, steps[Math.floor(i / 6) % 6]!, steps[i % 6]!);
  }
  const v = 8 + (n - 232) * 10;
  return hex(v, v, v);
}

/**
 * Display width in cells. We only need the coarse rule terminals apply: East
 * Asian Wide/Fullwidth and emoji take two columns, combining marks take none.
 */
export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff)
  ) {
    return 2;
  }
  return 1;
}

export interface Screen {
  cols: number;
  rows: number;
  /** Row-major grid; trailing empty rows are trimmed by `trim()`. */
  cells: Cell[][];
}

const EMPTY: Cell = { ch: ' ', style: {} };

/**
 * Replays `data` onto a cols x rows grid and returns the final screen state —
 * i.e. exactly what a user would be looking at after the stream stops.
 */
export function parseAnsi(data: string, cols: number, rows: number): Screen {
  const blankRow = (): Cell[] => Array.from({ length: cols }, () => ({ ...EMPTY }));
  let grid: Cell[][] = Array.from({ length: rows }, blankRow);
  let style: Style = {};
  let row = 0;
  let col = 0;

  const ensureRow = (r: number) => {
    while (grid.length <= r) grid.push(blankRow());
  };

  const put = (ch: string) => {
    const w = charWidth(ch);
    if (w === 0) return;
    ensureRow(row);
    if (col >= cols) {
      row += 1;
      col = 0;
      ensureRow(row);
    }
    grid[row]![col] = { ch, style: { ...style } };
    // A wide glyph owns the next cell too; blank it so nothing overprints.
    for (let i = 1; i < w && col + i < cols; i++) grid[row]![col + i] = { ch: '', style: { ...style } };
    col += w;
  };

  const sgr = (params: number[]) => {
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      if (p === 0) style = {};
      else if (p === 1) style.bold = true;
      else if (p === 2) style.dim = true;
      else if (p === 3) style.italic = true;
      else if (p === 4) style.underline = true;
      else if (p === 7) style.inverse = true;
      else if (p === 22) {
        style.bold = false;
        style.dim = false;
      } else if (p === 23) style.italic = false;
      else if (p === 24) style.underline = false;
      else if (p === 27) style.inverse = false;
      else if (p >= 30 && p <= 37) style.fg = BASIC[p - 30];
      else if (p === 39) style.fg = undefined;
      else if (p >= 40 && p <= 47) style.bg = BASIC[p - 40];
      else if (p === 49) style.bg = undefined;
      else if (p >= 90 && p <= 97) style.fg = BRIGHT[p - 90];
      else if (p >= 100 && p <= 107) style.bg = BRIGHT[p - 100];
      else if (p === 38 || p === 48) {
        const target = p === 38 ? 'fg' : 'bg';
        if (params[i + 1] === 2) {
          style[target] = hex(params[i + 2] ?? 0, params[i + 3] ?? 0, params[i + 4] ?? 0);
          i += 4;
        } else if (params[i + 1] === 5) {
          style[target] = xterm256(params[i + 2] ?? 0);
          i += 2;
        }
      }
    }
  };

  const chars = [...data];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;

    if (ch === '\x1b') {
      const next = chars[i + 1];
      if (next !== '[') {
        // Two-char escapes (ESC 7/8/M...) and OSC we do not emit: skip the pair.
        i += 1;
        continue;
      }
      // CSI: ESC [ <private?> <params> <final>
      let j = i + 2;
      let raw = '';
      while (j < chars.length && !/[A-Za-z]/.test(chars[j]!)) {
        raw += chars[j]!;
        j += 1;
      }
      const final = chars[j] ?? '';
      i = j;
      const priv = raw.startsWith('?');
      const params = (priv ? raw.slice(1) : raw)
        .split(';')
        .map((s) => (s === '' ? 0 : Number.parseInt(s, 10)))
        .map((n) => (Number.isNaN(n) ? 0 : n));

      if (priv) continue; // ?25l/h cursor visibility, ?2026 sync updates, ?1049 alt screen
      switch (final) {
        case 'm':
          sgr(params);
          break;
        case 'H':
        case 'f':
          row = Math.max(0, (params[0] || 1) - 1);
          col = Math.max(0, (params[1] || 1) - 1);
          break;
        case 'A':
          row = Math.max(0, row - (params[0] || 1));
          break;
        case 'B':
          row += params[0] || 1;
          break;
        case 'C':
          col = Math.min(cols - 1, col + (params[0] || 1));
          break;
        case 'D':
          col = Math.max(0, col - (params[0] || 1));
          break;
        case 'G':
          col = Math.max(0, (params[0] || 1) - 1);
          break;
        case 'J': {
          // ED: 0 = to end of screen, 1 = to start, 2/3 = whole screen.
          const mode = params[0] ?? 0;
          if (mode === 0) {
            ensureRow(row);
            for (let c = col; c < cols; c++) grid[row]![c] = { ...EMPTY };
            for (let r = row + 1; r < grid.length; r++) grid[r] = blankRow();
          } else if (mode === 1) {
            for (let r = 0; r < row; r++) grid[r] = blankRow();
            ensureRow(row);
            for (let c = 0; c <= col && c < cols; c++) grid[row]![c] = { ...EMPTY };
          } else {
            grid = Array.from({ length: rows }, blankRow);
          }
          break;
        }
        case 'K': {
          // EL: erase in line.
          const mode = params[0] ?? 0;
          ensureRow(row);
          const from = mode === 0 ? col : 0;
          const to = mode === 1 ? col : cols - 1;
          for (let c = from; c <= to; c++) grid[row]![c] = { ...EMPTY };
          break;
        }
        default:
          break;
      }
      continue;
    }

    if (ch === '\n') {
      row += 1;
      col = 0;
      ensureRow(row);
      continue;
    }
    if (ch === '\r') {
      col = 0;
      continue;
    }
    if (ch === '\t') {
      col = Math.min(cols - 1, col + (8 - (col % 8)));
      continue;
    }
    if (ch === '\b') {
      col = Math.max(0, col - 1);
      continue;
    }
    if (ch < ' ') continue;
    put(ch);
  }

  return { cols, rows: grid.length, cells: grid };
}

/** Drops trailing blank rows so a short frame does not carry dead space. */
export function trim(screen: Screen): Screen {
  const cells = [...screen.cells];
  const blank = (r: Cell[]) => r.every((c) => c.ch.trim() === '' && !c.style.bg);
  while (cells.length > 1 && blank(cells[cells.length - 1]!)) cells.pop();
  return { ...screen, rows: cells.length, cells };
}

/** Plain text of a screen — handy for asserting on a capture in a test. */
export function toText(screen: Screen): string {
  return screen.cells.map((row) => row.map((c) => c.ch || '').join('').replace(/\s+$/, '')).join('\n');
}
