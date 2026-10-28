/** What the training screen says, kept apart from how it says it. */
import type { DevelopStatus, JobStatus } from '../contract.js';

export interface ProfileSummary {
  name: string;
  trainedAt: string;
  edited: number;
  color: number;
  bw: number;
  /** null: never calibrated; stale: calibrated against an earlier training. */
  calibration: 'none' | 'current' | 'stale';
}

/** The trained profile, or undefined when there is none yet. */
export function profileSummary(status: DevelopStatus | undefined): ProfileSummary | undefined {
  const p = status?.profile;
  if (!p || p.exists === false || !p.name || !p.trainedAt) return undefined;
  return {
    name: p.name,
    trainedAt: p.trainedAt,
    edited: p.stats?.edited ?? 0,
    color: p.stats?.color ?? 0,
    bw: p.stats?.bw ?? 0,
    calibration: !p.calibration ? 'none' : p.calibration.stale ? 'stale' : 'current',
  };
}

/** "3 h 12 min", "4 min", "less than a minute". */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h${m > 0 ? ` ${m} min` : ''}` : `${m} min`;
}

export interface Outcome {
  tone: 'success' | 'info' | 'danger';
  title: string;
  text: string;
}

const FAILED: Partial<Record<JobStatus['kind'], string>> = {
  train: 'The training did not finish',
  calibrate: 'The calibration did not finish',
  catalog: 'The catalog export did not finish',
};

/** How a finished training, calibration or export check ended, in the photographer's terms. */
export function outcome(job: JobStatus | undefined): Outcome | undefined {
  if (!job || job.state === 'running') return undefined;
  const took = job.endedAt ? ` in ${duration(job.endedAt - job.startedAt)}` : '';
  // A finished export check shows its own report.
  if (job.kind === 'catalog' && job.state === 'done') return undefined;
  if (job.state === 'cancelled') {
    return { tone: 'info', title: 'Stopped', text: job.kind === 'train' ? 'The training was stopped; your profile is as it was.' : 'It was stopped.' };
  }
  if (job.state === 'failed') {
    return {
      tone: 'danger',
      title: FAILED[job.kind] ?? 'The job did not finish',
      text: job.error ?? 'Something went wrong.',
    };
  }
  if (job.kind === 'train') return { tone: 'success', title: 'Your style profile is ready', text: `Trained${took}.` };
  return job.result
    ? { tone: 'success', title: 'Calibration saved', text: 'The profile now corrects as strongly as you chose.' }
    : { tone: 'info', title: 'Nothing changed', text: 'The calibration closed without saving; the profile keeps its fitted values.' };
}

/** A label for the current step, counted when the job counts. */
export function stepLabel(job: JobStatus): string {
  const p = job.progress;
  if (!p) return 'Starting…';
  return p.total ? `${p.label} · ${p.done ?? 0} of ${p.total}` : p.label;
}
