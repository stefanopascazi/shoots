import type { JobProgress } from '@shoots/app';
import type { ProgressEvent } from '../progressChannel.js';

/** The latest event in a SHOOTS_PROGRESS_FILE, as the page shows it. Torn lines are skipped. */
export function lastProgress(text: string): JobProgress | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let event: ProgressEvent;
    try {
      event = JSON.parse(line) as ProgressEvent;
    } catch {
      continue;
    }
    switch (event.kind) {
      case 'phase':
        return { label: event.label, detail: event.detail };
      case 'steps':
        return { label: event.label, done: event.done, total: event.total, detail: event.detail };
      case 'download':
        return { label: event.label, done: event.received, total: event.total ?? undefined };
    }
  }
  return undefined;
}
