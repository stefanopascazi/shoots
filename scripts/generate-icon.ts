/**
 * Generates the shoots application icon.
 *
 * Usage:
 *   bun scripts/generate-icon.ts
 *
 * Source of truth is the SVG written to `assets/shoots.svg` (an aperture iris —
 * the mark is drawn from geometry, no fonts, so it rasterizes identically on any
 * machine). From it we emit:
 *   - assets/shoots.ico  — multi-resolution Windows icon, embedded in the
 *                          standalone .exe by scripts/build-binary.ts
 *   - assets/shoots.png  — 512px raster for docs / README / release pages
 *
 * Both outputs are committed: CI must not depend on sharp's SVG (librsvg)
 * support being present on every runner.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const repoRoot = path.resolve(import.meta.dir, '..');
const assets = path.join(repoRoot, 'assets');

// Brand palette. Warm amber on near-black: reads as photographic, and keeps
// enough contrast to stay legible at 16px against light *and* dark taskbars.
const BG = '#171b21';
const RING = '#f0b429';
const BLADE = '#ffd479';

const SIZE = 256;
const C = SIZE / 2;

/** Point on a circle centred in the canvas. Angles in degrees, 0 = up. */
function pt(angleDeg: number, radius: number): [number, number] {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [C + radius * Math.cos(a), C + radius * Math.sin(a)];
}

const f = (n: number) => n.toFixed(2);

/**
 * The iris: six blades, each a triangle spanning 60° between the inner opening
 * and the outer ring. Consecutive blades alternate rotation direction of their
 * leading edge, which is what gives an aperture its pinwheel silhouette.
 */
function blades(rInner: number, rOuter: number): string {
  const out: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 60;
    const [x1, y1] = pt(a, rInner);
    const [x2, y2] = pt(a + 60, rInner);
    const [x3, y3] = pt(a + 60, rOuter);
    out.push(
      `<path d="M${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} L${f(x3)} ${f(y3)} Z" fill="${BLADE}" fill-opacity="${i % 2 === 0 ? 0.95 : 0.62}"/>`,
    );
  }
  return out.join('\n  ');
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="52" fill="${BG}"/>
  <g>
  ${blades(52, 84)}
  </g>
  <circle cx="${C}" cy="${C}" r="92" fill="none" stroke="${RING}" stroke-width="16"/>
</svg>
`;

// ICO directory entries store the side length in a single byte; 256 is encoded
// as 0. Sizes below 32px get their own render (downscaling a 256px raster in the
// shell produces mush at 16px).
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function png(size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: (72 * size) / SIZE })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Pack PNG-compressed images into an .ico. PNG entries (rather than BMP) are
 * supported by every Windows version we target and keep the file ~10x smaller.
 */
function packIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const dirSize = 16 * images.length;
  let offset = header.length + dirSize;
  const dir = Buffer.alloc(dirSize);

  images.forEach((img, i) => {
    const at = i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, at); // width
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1); // height
    dir.writeUInt8(0, at + 2); // palette size: 0 = truecolor
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(img.data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });

  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

mkdirSync(assets, { recursive: true });
writeFileSync(path.join(assets, 'shoots.svg'), svg);

const images = await Promise.all(
  ICO_SIZES.map(async (size) => ({ size, data: await png(size) })),
);
const ico = packIco(images);
writeFileSync(path.join(assets, 'shoots.ico'), ico);
writeFileSync(path.join(assets, 'shoots.png'), await png(512));

console.log(`wrote assets/shoots.svg`);
console.log(`wrote assets/shoots.ico (${ICO_SIZES.join(', ')}px — ${ico.length} bytes)`);
console.log(`wrote assets/shoots.png (512px)`);
