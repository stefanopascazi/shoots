/**
 * Linux and macOS: one line in the user's own crontab.
 *
 * The user crontab and not `/etc/cron.d`: the job reads the photographer's
 * catalog and writes into their `~/.shoots`, so it must run as them, and a
 * per-user table needs no root to install and no root to remove.
 *
 * The table is rewritten rather than appended to, between two marker comments.
 * `crontab` has no notion of an addressable entry — the file is the only handle —
 * so a managed block is what makes install idempotent and uninstall precise:
 * everything the photographer put there themselves is copied through untouched,
 * and the previous shoots block is replaced instead of accumulating a second copy
 * every time `schedule install` runs.
 */
import { run } from '../exec.js';
import { formatTime, parseTime, type ScheduleBackend, type ScheduleSpec, type ScheduleState } from '../types.js';

const BEGIN = '# >>> shoots schedule >>>';
const END = '# <<< shoots schedule <<<';

/**
 * Quote one argument for the shell cron hands the command line to.
 *
 * Single quotes, because a photographer's folder can legitimately contain `$`,
 * a backtick or a space, and inside single quotes the shell expands none of
 * them. The one character that cannot appear there is the single quote itself,
 * which is closed, escaped and reopened in the usual way.
 */
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * `%` is not an ordinary character in a crontab command: cron turns it into a
 * newline and sends everything after the first one to the command's stdin.
 */
const escapePercent = (line: string): string => line.replace(/%/g, '\\%');

function jobLine(spec: ScheduleSpec): string {
  const time = parseTime(spec.at);
  if (!time) throw new Error(`invalid time '${spec.at}'`);
  const command = [spec.command, ...spec.args].map(quote).join(' ');
  // The run keeps its own log under ~/.shoots/logs, so cron's output is
  // discarded: left alone it would mail the photographer a full refine report
  // every night, on a machine where nobody reads local mail.
  return `${time.minute} ${time.hour} * * * ${escapePercent(command)} >/dev/null 2>&1`;
}

/** The table as it is now. A user with no crontab yet is an empty table. */
async function readTable(): Promise<string> {
  const result = await run('crontab', ['-l']);
  // "no crontab for <user>" exits non-zero on every implementation, and is
  // indistinguishable from a real failure by exit code alone — but an empty
  // table is the right reading of both, and writing one back is harmless.
  return result.code === 0 ? result.stdout : '';
}

async function writeTable(text: string): Promise<void> {
  const body = text.replace(/\n*$/, '\n');
  const result = await run('crontab', ['-'], body);
  if (result.code !== 0) {
    throw new Error(`crontab exited ${result.code}: ${result.stderr.trim() || 'no output'}`);
  }
}

/** The table with our block removed, and the block itself if there was one. */
function split(table: string): { rest: string; block: string[] } {
  const lines = table.split('\n');
  const rest: string[] = [];
  const block: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BEGIN) { inside = true; continue; }
    if (line.trim() === END) { inside = false; continue; }
    (inside ? block : rest).push(line);
  }
  return { rest: rest.join('\n').replace(/\n{3,}/g, '\n\n'), block };
}

export const cronBackend: ScheduleBackend = {
  id: 'cron',
  label: 'cron (user crontab)',

  async install(spec) {
    const { rest } = split(await readTable());
    const block = [
      BEGIN,
      '# Daily `shoots develop refine` over the shoots still cached under ~/.shoots.',
      '# Managed by `shoots schedule` — edit the time with `shoots schedule install --at HH:MM`.',
      jobLine(spec),
      END,
    ].join('\n');
    await writeTable(`${rest.replace(/\n*$/, '')}\n\n${block}\n`);
  },

  async read() {
    const { block } = split(await readTable());
    const entry = block.find((line) => line.trim() && !line.trim().startsWith('#'));
    if (!entry) {
      // A block whose only surviving line is commented out is a job somebody
      // disabled by hand rather than a job that was never installed.
      const commented = block.find((line) => /^\s*#\s*\d+\s+\d+\s+\*/.test(line));
      if (commented) {
        return { installed: true, disabled: true, notes: ['the crontab line is commented out'] };
      }
      return { installed: false };
    }
    const fields = entry.trim().split(/\s+/);
    const [minute, hour] = fields;
    const at = minute && hour && /^\d+$/.test(minute) && /^\d+$/.test(hour)
      ? formatTime(parseInt(hour, 10), parseInt(minute, 10))
      : undefined;
    return {
      installed: true,
      at,
      command: fields.slice(5).join(' '),
    } satisfies ScheduleState;
  },

  async remove() {
    const table = await readTable();
    const { rest, block } = split(table);
    if (block.length === 0) return false;
    await writeTable(rest);
    return true;
  },

  caveats() {
    const notes = [
      'cron runs with a minimal environment: the job uses absolute paths only, so nothing has to be on PATH.',
    ];
    if (process.platform === 'darwin') {
      // Real, and the single most common reason a macOS cron job silently does
      // nothing: TCC denies /usr/sbin/cron the protected folders by default.
      notes.push(
        'macOS: give /usr/sbin/cron Full Disk Access (System Settings → Privacy & Security)',
        '  if your photographs live under Desktop, Documents, Downloads or an external volume —',
        '  otherwise the job runs but sees an empty folder.',
      );
      notes.push('macOS: cron does not wake a sleeping Mac. The run is skipped, not queued.');
    }
    return notes;
  },
};
