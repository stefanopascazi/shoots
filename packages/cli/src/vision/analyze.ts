/**
 * One photograph through the vision model: caption, objects, sky and subject.
 *
 * Pixels are the RAW's embedded preview (or the file itself for a JPEG/TIFF),
 * turned upright from the RAW's orientation tag so that "top of the frame"
 * means the sky's side. The vision tower runs once; the four questions reuse it.
 */
import sharp from 'sharp';
import { loadRenderableImage, readOrientation } from '@shoots/imaging';
import { rasterisePolygons, type Florence } from '@shoots/inference';
import { MASK_GRID, packMask, type VisionObject, type VisionRecord } from './record.js';

/** Long edge of the analysed preview: the model sees 768² regardless. */
const ANALYSIS_EDGE = 768;
/** EXIF orientation to a clockwise rotation; mirrored orientations are rare in camera files. */
const ROTATION: Record<number, number> = { 3: 180, 6: 90, 8: 270 };
/** The phrase each region is segmented with. */
const REGION_PHRASES = { sky: 'sky', subject: 'person' } as const;
/** Detected object labels that mean a person is in the frame. */
const PERSON_LABELS = /\b(person|man|woman|boy|girl|child|human face|human head|bride|groom)\b/i;

/**
 * Which regions the photograph actually contains.
 *
 * Neither segmentation nor phrase grounding can say: both assume the phrase is
 * there and draw it anyway (on a reference catalog grounding found "sky" in
 * indoor portraits and a "person" in a field of flowers). The caption and the
 * object detector describe what is there without being prompted, so presence is
 * read from them.
 */
export function presentRegions(caption: string, labels: readonly string[]): (keyof typeof REGION_PHRASES)[] {
  const out: (keyof typeof REGION_PHRASES)[] = [];
  if (/\b(sky|skies|clouds?|sunset|sunrise)\b/i.test(caption) || labels.some((l) => /\b(sky|cloud)/i.test(l))) out.push('sky');
  if (labels.some((l) => PERSON_LABELS.test(l))) out.push('subject');
  return out;
}

export async function analyzePhotograph(florence: Florence, file: string): Promise<VisionRecord> {
  const { buffer } = await loadRenderableImage(file);
  const rotate = ROTATION[await readOrientation(file)] ?? 0;
  const { data, info } = await sharp(buffer)
    .rotate(rotate)
    .resize(ANALYSIS_EDGE, ANALYSIS_EDGE, { fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const image = await florence.see(new Uint8Array(data), info.width, info.height);

  const caption = await florence.caption(image);
  const detected = await florence.detect(image);
  const objects: VisionObject[] = detected.labels.map((label, i) => {
    const [x0, y0, x1, y1] = detected.boxes[i]!;
    const r = (v: number): number => Math.round(v * 1000) / 1000;
    return { label, box: [r(x0 / info.width), r(y0 / info.height), r(x1 / info.width), r(y1 / info.height)] };
  });

  const regions: VisionRecord['regions'] = {};
  for (const region of presentRegions(caption, detected.labels)) {
    const polys = await florence.segment(image, `the ${REGION_PHRASES[region]}`);
    const mask = rasterisePolygons(polys, info.width, info.height, MASK_GRID, MASK_GRID);
    if (mask.some((v) => v)) regions[region] = packMask(mask);
  }
  return { caption, objects, regions };
}
