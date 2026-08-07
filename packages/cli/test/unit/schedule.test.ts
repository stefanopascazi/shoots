/**
 * The seam between shoots and the OS scheduler.
 *
 * The backends themselves talk to `crontab` and `schtasks`, which a unit test
 * has no business invoking; what is pinned here is the time parsing every
 * backend feeds its own dialect, and the platform routing.
 */
import { describe, expect, test } from 'bun:test';
import { formatTime, JOB_COMMAND, parseTime } from '../../src/schedule/types.js';
import { resolveBackend } from '../../src/schedule/backends/index.js';

describe('parseTime', () => {
  test('reads a padded 24-hour time', () => {
    expect(parseTime('03:00')).toEqual({ hour: 3, minute: 0 });
    expect(parseTime('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseTime('00:00')).toEqual({ hour: 0, minute: 0 });
  });

  test('accepts a single-digit hour', () => {
    expect(parseTime('3:05')).toEqual({ hour: 3, minute: 5 });
  });

  test('ignores surrounding whitespace', () => {
    expect(parseTime('  03:00 ')).toEqual({ hour: 3, minute: 0 });
  });

  test('rejects an out-of-range time rather than wrapping it', () => {
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
  });

  test('requires two digits of minutes', () => {
    expect(parseTime('3:5')).toBeNull();
    expect(parseTime('03:005')).toBeNull();
  });

  test('rejects anything that is not HH:MM', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime('3am')).toBeNull();
    expect(parseTime('03:00:00')).toBeNull();
    expect(parseTime('03-00')).toBeNull();
  });
});

describe('formatTime', () => {
  test('pads both fields to two digits', () => {
    expect(formatTime(3, 0)).toBe('03:00');
    expect(formatTime(23, 59)).toBe('23:59');
  });

  test('round-trips through parseTime', () => {
    for (const at of ['00:00', '07:30', '23:59']) {
      const { hour, minute } = parseTime(at)!;
      expect(formatTime(hour, minute)).toBe(at);
    }
  });
});

describe('JOB_COMMAND', () => {
  test('is the one job the scheduler registers', () => {
    expect([...JOB_COMMAND]).toEqual(['schedule', 'run']);
  });
});

describe('resolveBackend', () => {
  test('picks the scheduler this platform actually has', () => {
    const backend = resolveBackend();
    if (process.platform === 'win32') expect(backend!.id).toBe('schtasks');
    else if (process.platform === 'linux' || process.platform === 'darwin') expect(backend!.id).toBe('cron');
    else expect(backend).toBeNull();
  });

  test('the chosen backend describes itself and its caveats', () => {
    const backend = resolveBackend();
    if (!backend) return;
    expect(backend.label.length).toBeGreaterThan(0);
    expect(Array.isArray(backend.caveats())).toBe(true);
  });
});
