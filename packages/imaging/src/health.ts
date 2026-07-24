/**
 * Small introspection helpers for `shoots doctor`. Kept in the imaging layer so
 * the CLI never has to depend on sharp directly (sharp is a native, bundler-
 * sensitive dependency owned by this package).
 */
import sharp from 'sharp';

/** libvips version backing sharp, or null if unavailable. Reaching this code
 *  means sharp itself loaded (it is imported at module init). */
export function sharpVips(): string | null {
  try {
    return sharp.versions?.vips ?? null;
  } catch {
    return null;
  }
}
