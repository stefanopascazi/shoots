/**
 * Shared sharp input options for every decode shoots performs.
 *
 * sharp's defaults are tuned for untrusted uploads, which is the wrong posture
 * here: the input is the photographer's own catalog, and ordinary Photoshop
 * exports trip both guards.
 *
 * - `failOn: 'none'` — by default *any* libvips warning is promoted to a hard
 *   error. Layered TIFFs written by Photoshop warn "Sum of Photometric
 *   type-related color channels and ExtraSamples doesn't match SamplesPerPixel"
 *   on every tile; the pixels decode fine regardless.
 * - `unlimited: true` — libvips caps a TIFF read at 50MB of cumulated libtiff
 *   allocation. A layered export carries its whole edit stack in a single
 *   `ImageSourceData` tag, routinely >100MB, so the read aborts before reaching
 *   the image.
 *
 * Either one silently costs real frames: a rejected file is a frame missing from
 * a cull report, or a training example missing from a develop dataset. Corrupt
 * input still fails — this relaxes warnings and size caps, not validity.
 */
import type { SharpOptions } from 'sharp';

export const SHARP_INPUT: SharpOptions = {
  failOn: 'none',
  unlimited: true,
};
