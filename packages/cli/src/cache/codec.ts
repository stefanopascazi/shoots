/**
 * Float vectors in and out of a JSONL pack.
 *
 * A CLIP embedding is 512 float32. Written as JSON numbers it is about 5KB per
 * photograph; as base64 of the raw bytes it is 2.7KB, and it parses without
 * touching 512 separate number literals. On a catalog where every frame carries
 * one, that difference is hundreds of megabytes and several seconds a run.
 *
 * Full precision, deliberately. Halving the width to float16 would save another
 * kilobyte a frame and change scores in the third decimal — which is exactly the
 * thing this cache promises never to do. A cached answer has to be the answer.
 *
 * The bytes are host-endian, which is a non-issue in practice (the cache is
 * machine-local, and every platform shoots runs on is little-endian) and would
 * show up as nonsense scores rather than silence if it ever were one. If a
 * shared SHOOTS_HOME across architectures ever becomes real, this is the place
 * that has to learn about it.
 */

/** Pack a float vector into base64. */
export function encodeFloats(values: Float32Array): string {
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64');
}

/**
 * Unpack a base64 float vector, or null when it is not one.
 *
 * Copies rather than viewing the decoded buffer: a Buffer from base64 carries no
 * alignment guarantee, and a Float32Array view over an odd offset throws.
 * Returns null for a truncated or corrupt value so the caller can treat it as a
 * miss instead of a crash.
 */
export function decodeFloats(encoded: unknown): Float32Array | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }
  if (raw.byteLength === 0 || raw.byteLength % 4 !== 0) return null;
  const out = new Float32Array(raw.byteLength / 4);
  Buffer.from(out.buffer, out.byteOffset, out.byteLength).set(raw);
  return out;
}
