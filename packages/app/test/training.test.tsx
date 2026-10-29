/** @jsxImportSource preact */
import { describe, expect, test } from 'bun:test';
import { render } from 'preact-render-to-string';
import type { DevelopStatus, JobStatus } from '../src/contract.js';
import { duration, embeddableReviewUrl, outcome, profileSummary, stepLabel } from '../src/training/model.js';
import { ProfileCard } from '../src/training/ProfileCard.js';
import { CatalogReportCard } from '../src/training/CatalogReportCard.js';
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

  test('an improvement says the profile learned, and a stopped one that nothing changed', () => {
    expect(outcome(job({ kind: 'refine', state: 'done' }))!.title).toBe('Your profile has learned from this shoot');
    expect(outcome(job({ kind: 'refine', state: 'cancelled' }))!.text).toContain('profile is as it was');
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

describe('embeddableReviewUrl', () => {
  test('only the CLI review server on this machine', () => {
    expect(embeddableReviewUrl('http://127.0.0.1:7391/')).toBe('http://127.0.0.1:7391/');
    expect(embeddableReviewUrl('http://localhost:7391/')).toBeUndefined();
    expect(embeddableReviewUrl('https://127.0.0.1:7391/')).toBeUndefined();
    expect(embeddableReviewUrl('http://example.com/')).toBeUndefined();
    expect(embeddableReviewUrl('not a url')).toBeUndefined();
    expect(embeddableReviewUrl(undefined)).toBeUndefined();
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
    expect(html).toContain('<iframe class="app-calibration" src="http://127.0.0.1:7391/"');
    expect(html).toContain('href="http://127.0.0.1:7391/"');
    expect(html).toContain('Open in a new tab');
  });

  test('a page it may not frame is only a link', () => {
    const html = render(
      <TrainingJobCard job={job({ kind: 'calibrate', progress: { label: 'Waiting', url: 'http://example.com/' } })} onCancel={() => {}} />,
    );
    expect(html).not.toContain('<iframe');
    expect(html).toContain('Open the calibration page');
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

describe('export only', () => {
  const report = {
    file: 'C:/x/catalog.json',
    folder: 'C:/Shoot',
    photos: 12,
    withSettings: 12,
    edited: 9,
    bw: 1,
    raw: true,
    missing: ['Exposure2012'],
    unknown: ['Exposure', 'ProcessVersion'],
    shapes: { ToneCurvePV2012: 'array of 4 numbers' },
  };

  test('a finished check shows its report, not an outcome', () => {
    expect(outcome(job({ kind: 'catalog', state: 'done', result: report }))).toBeUndefined();
    expect(outcome(job({ kind: 'catalog', state: 'failed', error: 'x' }))!.title).toBe('The catalog export did not finish');
  });

  test('the report names what did not match and how the curve arrived', () => {
    const html = render(<CatalogReportCard report={report} />);
    expect(html).toContain('1 names not found');
    expect(html).toContain('Exposure2012');
    expect(html).toContain('Returned but not read (2)');
    expect(html).toContain('array of 4 numbers');
  });

  test('warns when the plug-in sent no raw settings', () => {
    expect(render(<CatalogReportCard report={{ ...report, raw: false }} />)).toContain('No raw settings');
  });
});
