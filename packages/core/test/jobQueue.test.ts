/**
 * The batch runner beneath every long command.
 *
 * Two invariants matter more than throughput: one bad file never aborts the
 * batch, and results come back in input order however the workers interleave.
 */
import { describe, expect, test } from 'bun:test';
import { JobQueue } from '../src/jobs/JobQueue.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('JobQueue.run', () => {
  test('preserves input order regardless of completion order', async () => {
    const queue = new JobQueue({ concurrency: 4 });
    const items = [40, 5, 30, 1, 20];
    const outcomes = await queue.run(items, async (ms) => {
      await tick(ms);
      return ms * 2;
    });

    expect(outcomes.map((o) => o.item)).toEqual(items);
    expect(outcomes.map((o) => o.value)).toEqual([80, 10, 60, 2, 40]);
    expect(outcomes.map((o) => o.index)).toEqual([0, 1, 2, 3, 4]);
  });

  test('captures a failure per item and keeps running the rest', async () => {
    const queue = new JobQueue({ concurrency: 2 });
    const outcomes = await queue.run([1, 2, 3, 4], async (n) => {
      if (n === 2) throw new Error('bad file');
      return n;
    });

    expect(outcomes.map((o) => o.ok)).toEqual([true, false, true, true]);
    expect(outcomes[1]!.error).toBeInstanceOf(Error);
    expect(outcomes[1]!.error!.message).toBe('bad file');
    expect(outcomes[1]!.value).toBeUndefined();
  });

  test('wraps a non-Error rejection so callers always get an Error', async () => {
    const queue = new JobQueue();
    const [outcome] = await queue.run(['x'], async () => {
      throw 'plain string';
    });

    expect(outcome!.ok).toBe(false);
    expect(outcome!.error).toBeInstanceOf(Error);
    expect(outcome!.error!.message).toBe('plain string');
  });

  test('never exceeds the configured concurrency', async () => {
    const queue = new JobQueue({ concurrency: 3 });
    let inFlight = 0;
    let peak = 0;
    await queue.run(Array.from({ length: 12 }, (_, i) => i), async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight -= 1;
    });

    expect(peak).toBe(3);
  });

  test('clamps a nonsensical concurrency up to one worker', async () => {
    const queue = new JobQueue({ concurrency: 0 });
    let inFlight = 0;
    let peak = 0;
    await queue.run([1, 2, 3], async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(2);
      inFlight -= 1;
    });

    expect(peak).toBe(1);
  });

  test('reports monotonic progress, once per item, with the label', async () => {
    const queue = new JobQueue({ concurrency: 2 });
    const seen: Array<{ completed: number; total: number; label?: string }> = [];
    await queue.run(
      ['a', 'b', 'c'],
      async (s) => s,
      (p) => seen.push({ ...p }),
      (s) => `file-${s}`,
    );

    expect(seen.map((p) => p.completed)).toEqual([1, 2, 3]);
    expect(seen.every((p) => p.total === 3)).toBe(true);
    expect(seen.map((p) => p.label).sort()).toEqual(['file-a', 'file-b', 'file-c']);
  });

  test('handles an empty batch without calling the worker', async () => {
    const queue = new JobQueue();
    let called = 0;
    const outcomes = await queue.run([], async () => {
      called += 1;
    });

    expect(outcomes).toEqual([]);
    expect(called).toBe(0);
  });
});
