/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test';
import { render } from 'preact-render-to-string';
import type { DevelopStatus, JobStatus } from '../src/contract.js';
import { duration, outcome, profileSummary, stepLabel } from '../src/training/model.js';
import { ProfileCard } from '../src/training/ProfileCard.js';
import { TrainingJobCard } from '../src/training/TrainingJobCard.js';

const status = (profile: DevelopStatus['profile']): DevelopStatus => ({
  command: 'develop-status',
  dataset: { path: 'd', exists: true, bytes: 1 },
  profile,
});

const job = (patch: Partial<JobStatus>): JobStatus => ({ id: 'j', kind: 'train', state: 'running', startedAt: 0, ...patch });

describe('profileSummary', () => {
  test('none until a profile exists', () => {
    expect(profileSummary(undefined)).toBeUndefined();
    expect(profileSummary(status({ path: 'p', exists: false }))).toBeUndefined();
  });

  test('reads the counts and whether the calibration still matches', () => {
    const base = { path: 'p', name: 'my-style', trainedAt: '2026-10-28T10:00:00Z', stats: { edited: 40, color: 30, bw: 10 } };
    expect(profileSummary(status({ ...base, calibration: null }))).toMatchObject({ edited: 40, bw: 10, calibration: 'none' });
    expect(profileSummary(status({ ...base, calibration: { at: 'x', stale: true } }))!.calibration).toBe('stale');
    expect(profileSummary(status({ ...base, calibration: { at: 'x', stale: false } }))!.calibration).toBe('current');
  });
});

describe('duration', () => {
  test('hours and minutes', () => {
    expect(duration(30_000)).toBe('less than a minute');
    expect(duration(4 * 60_000)).toBe('4 min');
    expect(duration(192 * 60_000)).toBe('3 h 12 min');
    expect(duration(120 * 60_000)).toBe('2 h');
  });
});

describe('outcome', () => {
  test('nothing while running', () => {
    expect(outcome(job({}))).toBeUndefined();
  });

  test('a finished training says how long it took', () => {
    expect(outcome(job({ state: 'done', endedAt: 5 * 60_000 }))).toMatchObject({ tone: 'success', text: 'Trained in 5 min.' });
  });

  test('a calibration closed without saving changed nothing', () => {
    expect(outcome(job({ kind: 'calibrate', state: 'done' }))!.title).toBe('Nothing changed');
    expect(outcome(job({ kind: 'calibrate', state: 'done', result: { review: {} } }))!.title).toBe('Calibration saved');
  });

  test('a failure carries its error', () => {
    expect(outcome(job({ state: 'failed', error: 'No edited files found' }))).toMatchObject({ tone: 'danger', text: 'No edited files found' });
  });
});

describe('stepLabel', () => {
  test('counted when the job counts', () => {
    expect(stepLabel(job({ progress: { label: 'Develop-export', done: 3, total: 9 } }))).toBe('Develop-export · 3 of 9');
    expect(stepLabel(job({}))).toBe('Starting…');
  });
});

describe('TrainingJobCard', () => {
  test('offers the review page once the calibration serves one', () => {
    const html = render(
      <TrainingJobCard
        job={job({ kind: 'calibrate', progress: { label: 'Waiting for your review', url: 'http://127.0.0.1:7391/' } })}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain('href="http://127.0.0.1:7391/"');
    expect(html).toContain('target="_blank"');
  });

  test('says it outlives Lightroom', () => {
    expect(render(<TrainingJobCard job={job({})} onCancel={() => {}} />)).toContain('carries on if Lightroom closes');
  });
});

describe('ProfileCard', () => {
  test('an empty state before the first training', () => {
    expect(render(<ProfileCard profile={undefined} />)).toContain('No profile yet');
  });
});
