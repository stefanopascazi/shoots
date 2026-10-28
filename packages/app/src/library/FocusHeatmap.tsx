/** @jsxImportSource preact */
import type { FocusMap } from '../contract.js';
import { heatLevels } from './model.js';

/** Cool → hot, soft → sharp. The softest band is left clear so the photograph shows through. */
export const HEAT_COLORS = ['transparent', '#0ea5e9', '#22d3ee', '#a3e635', '#fde047'] as const;

export const heatColor = (level: number): string =>
  HEAT_COLORS[Math.min(HEAT_COLORS.length - 1, Math.max(0, Math.round(level * (HEAT_COLORS.length - 1))))];

/** Where focus landed, laid over the photograph tile by tile. */
export function FocusHeatmap({ map }: { map: FocusMap }) {
  const levels = heatLevels(map.tiles);
  return (
    <div
      class="app-heatmap"
      aria-hidden="true"
      style={{ gridTemplateColumns: `repeat(${map.cols}, 1fr)`, gridTemplateRows: `repeat(${map.rows}, 1fr)` }}
    >
      {levels.map((l) => (
        <span style={{ background: heatColor(l) }} />
      ))}
    </div>
  );
}

export function HeatLegend() {
  return (
    <div class="app-heat-legend">
      <span>Soft</span>
      <span class="app-heat-legend__bar" style={{ background: `linear-gradient(to right, ${HEAT_COLORS.slice(1).join(', ')})` }} />
      <span>Sharp</span>
    </div>
  );
}
