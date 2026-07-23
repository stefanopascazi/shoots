/**
 * Simple concurrency-limited job queue for batch file operations.
 * No external dependencies; emits progress via a callback so UI layers
 * (Ink, plain logging, a future REST API) can subscribe without coupling.
 */

export interface JobProgress {
  completed: number;
  total: number;
  /** Human-readable label of the most recently finished item (e.g. a file name). */
  label?: string;
}

export type ProgressListener = (progress: JobProgress) => void;

export interface JobOutcome<TIn, TOut> {
  item: TIn;
  index: number;
  ok: boolean;
  value?: TOut;
  error?: Error;
}

export interface JobQueueOptions {
  /** Max jobs in flight at once. Default: 4. */
  concurrency?: number;
}

export class JobQueue {
  private readonly concurrency: number;

  constructor(options: JobQueueOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 4);
  }

  /**
   * Run `worker` over every item with bounded concurrency.
   * Individual failures are captured per-item (never thrown) so a bad file
   * cannot abort the rest of the batch. Results preserve input order.
   */
  async run<TIn, TOut>(
    items: readonly TIn[],
    worker: (item: TIn, index: number) => Promise<TOut>,
    onProgress?: ProgressListener,
    labelOf?: (item: TIn) => string,
  ): Promise<JobOutcome<TIn, TOut>[]> {
    const outcomes: JobOutcome<TIn, TOut>[] = new Array(items.length);
    let nextIndex = 0;
    let completed = 0;

    const runOne = async (): Promise<void> => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        const item = items[index];
        try {
          const value = await worker(item, index);
          outcomes[index] = { item, index, ok: true, value };
        } catch (err) {
          outcomes[index] = {
            item,
            index,
            ok: false,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
        completed += 1;
        onProgress?.({ completed, total: items.length, label: labelOf?.(item) });
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, items.length) }, () => runOne());
    await Promise.all(workers);
    return outcomes;
  }
}
