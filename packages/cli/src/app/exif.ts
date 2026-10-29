/**
 * The capture data the photo viewer shows: which exiftool tags to read and how
 * to turn one record into display strings. Pure apart from the tag list.
 */
import type { PhotoExif } from '@shoots/app';
import type { ExifRecord } from '@shoots/imaging';

/** `#` asks exiftool for the numeric value: decimal GPS degrees instead of deg/min/sec. */
export const EXIF_TAGS = [
  'DateTimeOriginal',
  'Make',
  'Model',
  'LensID',
  'LensModel',
  'ExposureTime',
  'FNumber',
  'ISO',
  'ExposureCompensation',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'ExposureProgram',
  'MeteringMode',
  'Flash',
  'WhiteBalance',
  'ImageSize',
  'GPSLatitude#',
  'GPSLongitude#',
];

function text(record: ExifRecord, tag: string): string | undefined {
  const v = record[tag];
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t && !/^unknown\b/i.test(t) ? t : undefined;
}

/** "50.0 mm" reads as "50 mm". */
const millimetres = (v: string | undefined) => v?.replace(/\.0 mm$/, ' mm');

function camera(record: ExifRecord): string | undefined {
  const model = text(record, 'Model');
  const brand = text(record, 'Make')?.split(/\s+/)[0];
  if (!model) return brand;
  // "Canon EOS R5" already names its maker; "ILCE-7M3" needs "SONY" in front.
  return brand && !model.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${model}` : model;
}

/** "+1/3", "-0.7" or "0" as a number of stops. */
function stops(v: string): number {
  const m = /^([+-]?\d+)\/(\d+)$/.exec(v);
  return m ? Number(m[1]) / Number(m[2]) : Number(v);
}

function exposure(record: ExifRecord): string | undefined {
  const shutter = text(record, 'ExposureTime');
  const aperture = text(record, 'FNumber');
  const iso = text(record, 'ISO');
  const ev = text(record, 'ExposureCompensation');
  const parts = [
    shutter && `${shutter} s`,
    aperture && `f/${aperture}`,
    iso && `ISO ${iso}`,
    ev && stops(ev) !== 0 && `${ev} EV`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

function focalLength(record: ExifRecord): string | undefined {
  const focal = millimetres(text(record, 'FocalLength'));
  const full = millimetres(text(record, 'FocalLengthIn35mmFormat'));
  if (!focal) return full;
  return full && full !== focal ? `${focal} (${full} full frame)` : focal;
}

function location(record: ExifRecord): string | undefined {
  const lat = record['GPSLatitude'];
  const lon = record['GPSLongitude'];
  if (typeof lat !== 'number' || typeof lon !== 'number' || (lat === 0 && lon === 0)) return undefined;
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/** One exiftool record as the viewer shows it; fields the camera did not record are left out. */
export function summarizeExif(record: ExifRecord): PhotoExif {
  const taken = text(record, 'DateTimeOriginal')?.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const size = text(record, 'ImageSize')?.match(/^(\d+)\s*[x ]\s*(\d+)$/);
  const mode = [text(record, 'ExposureProgram'), text(record, 'MeteringMode')].filter(Boolean).join(' · ');
  const out: PhotoExif = {
    taken,
    camera: camera(record),
    lens: text(record, 'LensID') ?? text(record, 'LensModel'),
    exposure: exposure(record),
    focalLength: focalLength(record),
    mode: mode || undefined,
    flash: text(record, 'Flash'),
    whiteBalance: text(record, 'WhiteBalance'),
    dimensions: size ? `${size[1]} × ${size[2]}` : undefined,
    location: location(record),
  };
  for (const k of Object.keys(out) as (keyof PhotoExif)[]) if (out[k] === undefined) delete out[k];
  return out;
}
