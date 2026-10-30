/**
 * Florence-2's answers, from generated text to structures.
 *
 * Coordinates come as `<loc_N>` tokens, N in 0..999 quantised over each axis;
 * the bin centre is the value. Boxes are four of them after a label (the label
 * repeats the previous one when omitted, as in "person<box><box>"), polygons
 * are pairs separated by `<sep>`.
 */

export const LOC_BINS = 1000;

const strip = (text: string): string => text.replaceAll('<s>', '').replaceAll('</s>', '').replaceAll('<pad>', '');
const loc = (n: string, extent: number): number => ((Number(n) + 0.5) / LOC_BINS) * extent;

export interface Boxes {
  labels: string[];
  /** [x0, y0, x1, y1] in pixels of the image the answer is about. */
  boxes: [number, number, number, number][];
}

/** Plain-text answers (captions): special tokens dropped, whitespace tidied. */
export function parseText(raw: string): string {
  return strip(raw).replace(/\s+/g, ' ').trim();
}

/** Labelled boxes (object detection, phrase grounding). */
export function parseBoxes(raw: string, width: number, height: number): Boxes {
  const labels: string[] = [];
  const boxes: Boxes['boxes'] = [];
  for (const m of strip(raw).matchAll(/([^<]+)?<loc_(\d+)><loc_(\d+)><loc_(\d+)><loc_(\d+)>/g)) {
    labels.push(m[1]?.trim() || labels.at(-1) || '');
    boxes.push([loc(m[2]!, width), loc(m[3]!, height), loc(m[4]!, width), loc(m[5]!, height)]);
  }
  return { labels, boxes };
}

/** Segmentation polygons as flat [x0, y0, x1, y1, …] pixel lists; fewer than three points are dropped. */
export function parsePolygons(raw: string, width: number, height: number): number[][] {
  return strip(raw)
    .split('<sep>')
    .map((part) => {
      const locs = [...part.matchAll(/<loc_(\d+)>/g)].map((m) => m[1]!);
      const poly: number[] = [];
      for (let i = 0; i + 1 < locs.length; i += 2) poly.push(loc(locs[i]!, width), loc(locs[i + 1]!, height));
      return poly;
    })
    .filter((p) => p.length >= 6);
}

/** Polygons onto a w×h grid (even–odd rule): 1 inside, 0 outside. */
export function rasterisePolygons(polys: readonly number[][], width: number, height: number, w: number, h: number): Uint8Array {
  const mask = new Uint8Array(w * h);
  for (let gy = 0; gy < h; gy++) {
    const y = ((gy + 0.5) / h) * height;
    for (let gx = 0; gx < w; gx++) {
      const x = ((gx + 0.5) / w) * width;
      let inside = false;
      for (const p of polys) {
        for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
          const [xi, yi, xj, yj] = [p[i]!, p[i + 1]!, p[j]!, p[j + 1]!];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
      mask[gy * w + gx] = inside ? 1 : 0;
    }
  }
  return mask;
}
