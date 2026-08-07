/**
 * How many files a batch command works on at once, when nobody said.
 *
 * The old answer was 4, everywhere, chosen before any of this was measured. On
 * a machine with sixteen logical cores that leaves three quarters of it idle
 * while a photographer waits. Every number below comes from a grid over a real
 * workload (40 frames at 4000x3000, an AMD 5800H, 16 logical CPUs) rather than
 * from reasoning about thread pools, because reasoning about thread pools got
 * two of the three predictions wrong.
 *
 * The two kinds of work want different answers, so there are two functions.
 */
import os from 'node:os';

/** Logical CPUs, never less than one however odd the host. */
function cpuCount(): number {
  const n = os.cpus()?.length ?? 0;
  return n > 0 ? n : 1;
}

/**
 * Decode-bound work: culling, thumbnails, anything that is libvips and little
 * else.
 *
 *   concurrency   1     4     8    16    24    32
 *   ms         4622  1477   901   805   739   779
 *
 * Throughput climbs with the core count and flattens just past it — 24 beats 16
 * by 7%, and 32 is already worse. It is capped anyway, because the memory does
 * not flatten: peak resident size grew from 277MB at 4 to 638MB at 16 and 756MB
 * at 24, roughly 25MB per worker, and a 64-core machine reading 60-megapixel
 * frames would spend gigabytes buying that last 7%.
 *
 * libvips is left alone. Its thread pool is per *process* and already sized to
 * the machine, so the oversubscription this was expected to cause does not
 * happen: forcing sharp.concurrency to 1, 2 or 4 moved the totals by less than
 * the run-to-run noise at every queue depth tried.
 */
export function defaultImageConcurrency(): number {
  return Math.min(cpuCount(), 16);
}

/**
 * Model-bound work: rating, embedding, the develop export — a decode followed
 * by a forward pass through ONNX Runtime.
 *
 *   concurrency   1     4     8    16
 *   ms         3015  1042   869   995
 *
 * This one has a peak rather than a plateau, and it sits at half the core
 * count. ONNX Runtime brings its own thread pool and saturates the machine from
 * inside each call, so queue workers past that point take cores away from the
 * inference they are waiting on: 16 is 14% *slower* than 8.
 *
 * Constraining the runtime instead does not help — it hurts, badly. Pinning
 * intraOpNumThreads to 1 cost 2.6x at every depth, and even 4 was 25-35% worse
 * than letting it decide. Its default is left in place.
 */
export function defaultModelConcurrency(): number {
  return Math.max(1, Math.min(Math.round(cpuCount() / 2), 8));
}
