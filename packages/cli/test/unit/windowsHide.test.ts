/**
 * Every child process starts without a console window on Windows.
 *
 * Under the app (a detached run with no console of its own) or the Task
 * Scheduler, a console program launched without `windowsHide` opens a window
 * of its own: training a folder opened one per photograph, from the RAW
 * developer. Only launches that share the user's terminal are exempt.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const PACKAGES = path.resolve(import.meta.dir, '../../..');

/** They run inside the interactive shell and inherit its terminal, or open a viewer on purpose. */
const EXEMPT = new Set(['cli/src/shell/runner.ts', 'cli/src/pipeline/exec.ts', 'cli/src/shell/triage/open.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : sources(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('child processes', () => {
  test('every launch passes windowsHide', () => {
    const offenders: string[] = [];
    for (const pkg of readdirSync(PACKAGES)) {
      const src = path.join(PACKAGES, pkg, 'src');
      if (!statSync(path.join(PACKAGES, pkg)).isDirectory()) continue;
      let files: string[];
      try {
        files = sources(src);
      } catch {
        continue;
      }
      for (const file of files) {
        const rel = path.relative(PACKAGES, file).replaceAll('\\', '/');
        if (EXEMPT.has(rel)) continue;
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (!/\b(spawn|spawnSync|execFile|execFileSync)\(/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
          if (/function (spawn|execFile)|import /.test(line)) return;
          // The options object sits on the call's line or the few after it.
          if (!lines.slice(i, i + 6).join('\n').includes('windowsHide')) offenders.push(`${rel}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
