/**
 * Focus-map → terminal heatmap. Pure (no Ink) so it can be unit-tested: turns
 * the per-tile sharpness grid into intensity levels, normalised against the
 * frame's own sharpest tile, so the brightest cells mark where focus landed.
 */
import type { FocusMap } from '@shoots/imaging';

/** Block glyphs from faint to solid; index = intensity level. */
export const HEATMAP_BLOCKS = ['·', '░', '▒', '▓', '█'] as const;
/** Colours paired with the glyphs, cool → hot (soft → sharp). */
export const HEATMAP_COLORS = ['#334155', '#0ea5e9', '#22d3ee', '#a3e635', '#fde047'] as const;

const LEVELS = HEATMAP_BLOCKS.length;

/**
 * Reduce a focus map to a grid of intensity levels (0 … LEVELS-1), row-major.
 * Level scales with `sqrt(tileVariance / maxVariance)` so mid-sharpness regions
 * stay visible rather than being crushed by one very sharp tile.
 */
export function focusHeatmap(map: FocusMap): number[][] {
  const max = map.tiles.reduce((m, v) => (v > m ? v : m), 0);
  const grid: number[][] = [];
  for (let r = 0; r < map.rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < map.cols; c++) {
      const v = map.tiles[r * map.cols + c] ?? 0;
      const norm = max > 0 ? Math.sqrt(v / max) : 0;
      row.push(Math.min(LEVELS - 1, Math.max(0, Math.round(norm * (LEVELS - 1)))));
    }
    grid.push(row);
  }
  return grid;
}
