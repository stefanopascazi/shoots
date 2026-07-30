/**
 * Windows: one registered task in the Task Scheduler.
 *
 * Registered from an XML definition rather than from `schtasks /Create /TR`.
 * `/TR` takes the executable *and* its arguments as a single string, which then
 * goes through two rounds of quoting — Node's own command-line escaping and
 * schtasks' internal parsing — and a photographer's install path
 * (`C:\Program Files\...`) is exactly the case that breaks. The XML form keeps
 * `<Command>` and `<Arguments>` apart, so there is nothing to quote, and it also
 * carries the settings `/Create` cannot express: catch up on a missed run, do not
 * start a second copy if last night's is still going.
 *
 * Registered with `InteractiveToken` and no stored password: the task runs as the
 * photographer, with their drive mappings and their permissions, and installing
 * it needs no administrator and no credentials on disk. The price is that it only
 * fires while they are logged on, which is stated rather than worked around.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { run } from '../exec.js';
import { formatTime, parseTime, type ScheduleBackend, type ScheduleSpec, type ScheduleState } from '../types.js';

const TASK_NAME = 'Shoots Develop Refine';

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The account the task runs as, in the form the Task Scheduler expects. */
function currentUser(): string {
  const domain = process.env.USERDOMAIN;
  const user = process.env.USERNAME ?? os.userInfo().username;
  return domain ? `${domain}\\${user}` : user;
}

function taskXml(spec: ScheduleSpec): string {
  const time = parseTime(spec.at);
  if (!time) throw new Error(`invalid time '${spec.at}'`);
  // The date part of StartBoundary only says "not before"; the daily trigger is
  // what makes it recur, so today at the requested time is the right anchor.
  const start = `${new Date().toISOString().slice(0, 10)}T${formatTime(time.hour, time.minute)}:00`;

  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Author>shoots</Author>',
    '    <Description>Daily `shoots develop refine` over the shoots still cached under ~/.shoots. Managed by `shoots schedule`.</Description>',
    `    <URI>\\${xmlEscape(TASK_NAME)}</URI>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <CalendarTrigger>',
    `      <StartBoundary>${start}</StartBoundary>`,
    '      <Enabled>true</Enabled>',
    '      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>',
    '    </CalendarTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${xmlEscape(currentUser())}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    // A laptop on battery is the normal case for a photographer on location, and
    // refusing to run there would mean the job never runs at all.
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    // A refit over a large catalog is minutes, not hours; four hours is a
    // generous ceiling that still guarantees a wedged run cannot live forever.
    '    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xmlEscape(spec.command)}</Command>`,
    `      <Arguments>${xmlEscape(spec.args.join(' '))}</Arguments>`,
    `      <WorkingDirectory>${xmlEscape(path.dirname(spec.command))}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

const tag = (xml: string, name: string): string | undefined =>
  new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

export const schtasksBackend: ScheduleBackend = {
  id: 'schtasks',
  label: 'Windows Task Scheduler',

  async install(spec) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'shoots-schedule-'));
    const file = path.join(dir, 'task.xml');
    try {
      // schtasks reads /XML as UTF-16LE and rejects UTF-8 with a bare
      // "unexpected node" — the BOM is part of the contract, not decoration.
      await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(spec), 'utf16le')]));
      // /F replaces an existing registration, which is what makes a second
      // install an update rather than a duplicate-name failure.
      const result = await run('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F']);
      if (result.code !== 0) {
        throw new Error(`schtasks /Create exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },

  async read() {
    const result = await run('schtasks', ['/Query', '/TN', TASK_NAME, '/XML', 'ONE']);
    // Exit 1 with no XML is "no such task" — the ordinary not-installed answer.
    if (result.code !== 0 || !result.stdout.includes('<Task')) return { installed: false };

    const xml = result.stdout;
    const start = tag(xml, 'StartBoundary');
    const time = start ? /T(\d{2}):(\d{2})/.exec(start) : null;
    const command = tag(xml, 'Command');
    const args = tag(xml, 'Arguments');
    // `<Enabled>` appears in both the trigger and the settings; either one being
    // false stops the job, so a single false anywhere is the honest reading.
    const disabled = /<Enabled>false<\/Enabled>/.test(xml);

    return {
      installed: true,
      at: time ? `${time[1]}:${time[2]}` : undefined,
      command: command ? [command, args].filter(Boolean).join(' ') : undefined,
      disabled,
      notes: disabled ? ['the task is registered but disabled'] : undefined,
    } satisfies ScheduleState;
  },

  async remove() {
    // Asked first, because schtasks reports "no such task" and "you may not
    // touch that task" with the same exit code and a *localized* message —
    // matching English text here works on an English Windows and silently
    // mis-reports every other one. The query is the locale-independent answer.
    if (!(await schtasksBackend.read()).installed) return false;

    const result = await run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']);
    if (result.code !== 0) {
      throw new Error(`schtasks /Delete exited ${result.code}: ${(result.stderr || result.stdout).trim()}`);
    }
    return true;
  },

  caveats() {
    return [
      'The task runs as you, without a stored password, so it only fires while you are logged on.',
      'A run missed because the machine was off or asleep is started as soon as it is available.',
    ];
  },
};
