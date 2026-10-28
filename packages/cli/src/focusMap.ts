/**
 * The focus map as `cull --json` reports it: upright, the way the photograph is
 * displayed, so a viewer can lay it over the picture.
 *
 * A RAW's embedded preview usually carries no orientation of its own (the tag
 * lives in the RAW), so the blur analysis measured it as the sensor saw it. The
 * thumbnail code turns such previews upright from the RAW's tag; the map has to
 * be turned the same way or a portrait frame shows focus in the wrong place.
 */
import type { FocusMap } from '@shoots/imaging';

type Grid = (r: number, c: number) => number;

function build(rows: number, cols: number, at: Grid): FocusMap {
  const tiles: number[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push(at(r, c));
  return { cols, rows, tiles };
}

const get = (m: FocusMap): Grid => (r, c) => m.tiles[r * m.cols + c];

const rotate90 = (m: FocusMap) => build(m.cols, m.rows, (r, c) => get(m)(m.rows - 1 - c, r));
const rotate180 = (m: FocusMap) => build(m.rows, m.cols, (r, c) => get(m)(m.rows - 1 - r, m.cols - 1 - c));
const rotate270 = (m: FocusMap) => build(m.cols, m.rows, (r, c) => get(m)(c, m.cols - 1 - r));
const flop = (m: FocusMap) => build(m.rows, m.cols, (r, c) => get(m)(r, m.cols - 1 - c));
const flip = (m: FocusMap) => build(m.rows, m.cols, (r, c) => get(m)(m.rows - 1 - r, c));

/** Apply an EXIF orientation (1–8) to a map, mirroring the thumbnail's own transform. */
export function orientFocusMap(map: FocusMap, orientation: number): FocusMap {
  switch (orientation) {
    case 2:
      return flop(map);
    case 3:
      return rotate180(map);
    case 4:
      return flip(map);
    case 5:
      return flop(rotate90(map));
    case 6:
      return rotate90(map);
    case 7:
      return flop(rotate270(map));
    case 8:
      return rotate270(map);
    default:
      return map;
  }
}

export interface MeasuredFrame {
  focusMap: FocusMap;
  pixelSource: 'file' | 'embedded-preview';
  analyzedWidth: number;
  analyzedHeight: number;
}

/**
 * The reported map: whole-number tiles, turned upright. Ordinary files were
 * already turned by their own tag during analysis. A preview measured upright —
 * portrait pixels on a quarter-turn orientation — is left alone too.
 */
export function reportFocusMap(frame: MeasuredFrame, orientation: number): FocusMap {
  const rounded = { cols: frame.focusMap.cols, rows: frame.focusMap.rows, tiles: frame.focusMap.tiles.map((t) => Math.round(t)) };
  if (frame.pixelSource !== 'embedded-preview' || orientation <= 1) return rounded;
  const quarterTurn = orientation >= 5;
  if (quarterTurn && frame.analyzedHeight > frame.analyzedWidth) return rounded;
  return orientFocusMap(rounded, orientation);
}
