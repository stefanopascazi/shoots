import type { PhotoExif } from '../contract.js';

/** Viewer labels, in display order. */
const LABELS: [keyof PhotoExif, string][] = [
  ['taken', 'Taken'],
  ['camera', 'Camera'],
  ['lens', 'Lens'],
  ['exposure', 'Exposure'],
  ['focalLength', 'Focal length'],
  ['mode', 'Mode'],
  ['flash', 'Flash'],
  ['whiteBalance', 'White balance'],
  ['dimensions', 'Size'],
  ['location', 'Location'],
];

/** The recorded fields as label/value rows, in display order. */
export function exifRows(exif: PhotoExif): { label: string; value: string }[] {
  return LABELS.flatMap(([key, label]) => (exif[key] ? [{ label, value: exif[key]! }] : []));
}
