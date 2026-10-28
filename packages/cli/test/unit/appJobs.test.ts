import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { JobError, JobRunner, jobArgs, lastErrorLine } from '../../src/app/jobs.js';
import { exitCode, lastProgress } from '../../src/app/progress.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

function runner() {
  const spawned: Array<{ args: string[]; env: NodeJS.ProcessEnv; child: FakeChild }> = [];
  const jobs = new JobRunner((_cmd, args, env) => {
    const child = new FakeChild();
    spawned.push({ args, env, child });
    return child as unknown as ChildProcess;
  });
  return { jobs, spawned };
}

describe('jobArgs', () => {
  test('photo jobs are dry runs over the listed files', () => {
    expect(jobArgs({ kind: 'cull', folder: 'x' }, 'list.txt')).toEqual(['cull', '--files-from', 'list.txt', '--dry-run', '--json']);
    expect(jobArgs({ kind: 'rate', folder: 'x', profile: 'my-eye' }, 'l')).toEqual([
      'rate',
      '--files-from',
      'l',
      '--dry-run',
      '--json',
      '--profile',
      'my-eye',
    ]);
    expect(jobArgs({ kind: 'doctor' }, undefined)).toEqual(['doctor', '--json']);
  });
});

describe('lastProgress', () => {
  test('takes the last parsable line', () => {
    const text = [
      JSON.stringify({ kind: 'phase', label: 'Scanning' }),
      JSON.stringify({ kind: 'steps', label: 'Rating', done: 3, total: 10 }),
      '{"kind":"ste',
    ].join('\n');
    expect(lastProgress(text)).toEqual({ label: 'Rating', done: 3, total: 10, detail: undefined });
  });

  test('downloads map received onto done', () => {
    expect(lastProgress(JSON.stringify({ kind: 'download', label: 'model', received: 5, total: null }))).toEqual({
      label: 'model',
      done: 5,
      total: undefined,
    });
  });

  test('nothing written yet', () => {
    expect(lastProgress('')).toBeUndefined();
  });
});

describe('lastErrorLine', () => {
  test('returns the last error without its prefix', () => {
    expect(lastErrorLine('warn: x\nerror: first\nerror: second\n')).toBe('second');
    expect(lastErrorLine('nothing')).toBeUndefined();
  });
});

describe('JobRunner', () => {
  test('passes a progress file and parses the report on exit', () => {
    const { jobs, spawned } = runner();
    const started = jobs.start({ kind: 'cull', folder: 'f' }, ['a.cr3', 'b.cr3']);
    expect(started.state).toBe('running');
    expect(jobs.busy).toBe(true);
    expect(spawned[0].env.SHOOTS_PROGRESS_FILE).toBeTruthy();
    expect(spawned[0].args).toContain('--dry-run');

    spawned[0].child.stdout.emit('data', Buffer.from('{"command":"cull","results":[]}'));
    spawned[0].child.emit('close', 0);
    const done = jobs.get(started.id)!;
    expect(done.state).toBe('done');
    expect(done.result).toEqual({ command: 'cull', results: [] });
    expect(jobs.busy).toBe(false);
  });

  test('a report with exit code 1 still counts as done', () => {
    const { jobs, spawned } = runner();
    const s = jobs.start({ kind: 'doctor' });
    spawned[0].child.stdout.emit('data', Buffer.from('{"command":"doctor"}'));
    spawned[0].child.emit('close', 1);
    expect(jobs.get(s.id)!.state).toBe('done');
  });

  test('no report fails with the last error line', () => {
    const { jobs, spawned } = runner();
    const s = jobs.start({ kind: 'doctor' });
    spawned[0].child.stderr.emit('data', Buffer.from('error: model missing\n'));
    spawned[0].child.emit('close', 2);
    expect(jobs.get(s.id)).toMatchObject({ state: 'failed', error: 'model missing' });
  });

  test('one job at a time', () => {
    const { jobs } = runner();
    jobs.start({ kind: 'doctor' });
    expect(() => jobs.start({ kind: 'doctor' })).toThrow(JobError);
  });

  test('a photo job needs photos', () => {
    const { jobs } = runner();
    expect(() => jobs.start({ kind: 'rate', folder: 'f' }, [])).toThrow('no photos');
  });

  test('cancel kills the child and frees the runner', () => {
    const { jobs, spawned } = runner();
    const s = jobs.start({ kind: 'doctor' });
    expect(jobs.cancel(s.id)!.state).toBe('cancelled');
    expect(spawned[0].child.killed).toBe(true);
    expect(jobs.busy).toBe(false);
    spawned[0].child.emit('close', null);
    expect(jobs.get(s.id)!.state).toBe('cancelled');
  });
});

describe('exitCode', () => {
  test('the exit line ends the file; a run in progress has none', () => {
    const steps = JSON.stringify({ kind: 'steps', label: 'Fitting', done: 1, total: 2 });
    expect(exitCode(`${steps}\n${JSON.stringify({ kind: 'exit', code: 1 })}\n`)).toBe(1);
    expect(exitCode(`${steps}\n`)).toBeUndefined();
    expect(exitCode('')).toBeUndefined();
  });

  test('the exit line does not hide the last progress', () => {
    const text = `${JSON.stringify({ kind: 'phase', label: 'Done' })}\n${JSON.stringify({ kind: 'exit', code: 0 })}\n`;
    expect(lastProgress(text)).toEqual({ label: 'Done', detail: undefined });
  });
});
