import type { JobProgress } from '@shoots/app';
import type { ProgressLine } from '../progressChannel.js';

function* linesFromEnd(text: string): Generator<ProgressLine> {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      yield JSON.parse(line) as ProgressLine;
    } catch {
      // A torn line, still being written.
    }
  }
}

/** The latest event in a SHOOTS_PROGRESS_FILE, as the page shows it. Torn lines are skipped. */
export function lastProgress(text: string): JobProgress | undefined {
  for (const event of linesFromEnd(text)) {
    switch (event.kind) {
      case 'phase':
        return { label: event.label, detail: event.detail, ...(event.url ? { url: event.url } : {}) };
      case 'steps':
        return { label: event.label, done: event.done, total: event.total, detail: event.detail };
      case 'download':
        return { label: event.label, done: event.received, total: event.total ?? undefined };
    }
  }
  return undefined;
}

/** The exit code the process recorded at the end of its progress file; undefined while it runs. */
export function exitCode(text: string): number | undefined {
  for (const event of linesFromEnd(text)) return event.kind === 'exit' ? event.code : undefined;
  return undefined;
}
