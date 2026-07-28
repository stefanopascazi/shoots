/**
 * shoots doctor
 *
 * Environment health check: reports the shoots home, external tools (exiftool),
 * their runtime prerequisites (Perl, tar) and the native imaging stack (sharp).
 * Written as a list of independent checks so new probes can be appended as the
 * product grows. Exits non-zero if any check fails.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { shootsHome } from '@shoots/core';
import { exiftoolManifest, exiftoolVersion, resolveExiftool, resolveLibraw, librawManifest, sharpVips } from '@shoots/imaging';
import { clipModelManifest, resolveClipModel } from '@shoots/inference';
import { makeIo, printHuman, printJson } from '../io.js';

type CheckStatus = 'ok' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

interface DoctorOptions {
  json?: boolean;
  verbose?: boolean;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check the environment: shoots home, external tools and imaging stack')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'verbose logging on stderr')
    .action(runDoctor);
}

/** Run a command and capture combined output; never throws. */
function capture(cmd: string, args: string[]): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const buf: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => buf.push(c));
    child.stderr.on('data', (c: Buffer) => buf.push(c));
    child.on('error', () => resolve({ ok: false, text: '' }));
    child.on('close', (code) => resolve({ ok: code === 0, text: Buffer.concat(buf).toString('utf8').trim() }));
  });
}

const firstLine = (text: string): string => text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';

async function checkPlatform(): Promise<CheckResult> {
  return {
    name: 'platform',
    status: 'ok',
    detail: `${process.platform}/${process.arch}, node ${process.version}`,
  };
}

async function checkHome(): Promise<CheckResult> {
  const home = shootsHome();
  try {
    await mkdir(home, { recursive: true });
    const probe = path.join(home, `.doctor-${process.pid}`);
    await writeFile(probe, 'ok', 'utf8');
    await rm(probe, { force: true });
    return { name: 'shoots home', status: 'ok', detail: `${home} (writable)` };
  } catch (err) {
    return { name: 'shoots home', status: 'fail', detail: `${home} not writable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkTar(): Promise<CheckResult> {
  const r = await capture('tar', ['--version']);
  return r.ok
    ? { name: 'tar', status: 'ok', detail: firstLine(r.text) }
    : { name: 'tar', status: 'fail', detail: 'not found — needed to extract downloaded tools' };
}

async function checkPerl(): Promise<CheckResult> {
  const r = await capture('perl', ['-e', 'print $^V']);
  if (r.ok) return { name: 'perl', status: 'ok', detail: r.text || 'available' };
  // exiftool on macOS/Linux is the Perl distribution; on Windows it is native.
  return process.platform === 'win32'
    ? { name: 'perl', status: 'ok', detail: 'not required on Windows (exiftool is native)' }
    : { name: 'perl', status: 'fail', detail: 'not found — required to run exiftool on this OS' };
}

async function checkExiftool(): Promise<CheckResult> {
  const resolved = resolveExiftool();
  if (!resolved) {
    return { name: 'exiftool', status: 'warn', detail: 'not provisioned — run `shoots setup`' };
  }
  const version = await exiftoolVersion();
  return version
    ? { name: 'exiftool', status: 'ok', detail: `${version} (${resolved.command})` }
    : { name: 'exiftool', status: 'fail', detail: `resolved but not runnable (${resolved.command})` };
}

async function checkToolMirror(): Promise<CheckResult> {
  try {
    const m = exiftoolManifest();
    const configured = /^[0-9a-f]{64}$/.test(m.sha256);
    return configured
      ? { name: 'tool mirror', status: 'ok', detail: m.url }
      : { name: 'tool mirror', status: 'warn', detail: `no pinned checksum (base ${m.url})` };
  } catch (err) {
    return { name: 'tool mirror', status: 'warn', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkLibraw(): Promise<CheckResult> {
  // Explicit external developer wins over the provisioned binary.
  if (process.env.SHOOTS_RAW_DEVELOPER?.trim()) {
    return { name: 'libraw', status: 'ok', detail: `SHOOTS_RAW_DEVELOPER=${process.env.SHOOTS_RAW_DEVELOPER}` };
  }
  const bin = resolveLibraw();
  if (bin) return { name: 'libraw', status: 'ok', detail: bin };
  try {
    const m = librawManifest();
    const configured = /^[0-9a-f]{64}$/.test(m.sha256);
    return configured
      ? { name: 'libraw', status: 'warn', detail: 'not provisioned — run `shoots setup`' }
      : { name: 'libraw', status: 'warn', detail: `mirror not configured (base ${m.url})` };
  } catch (err) {
    return { name: 'libraw', status: 'warn', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSharp(): Promise<CheckResult> {
  const vips = sharpVips();
  return { name: 'sharp', status: 'ok', detail: vips ? `libvips ${vips}` : 'loaded' };
}

async function checkModel(): Promise<CheckResult> {
  const m = clipModelManifest();
  const configured = /^[0-9a-f]{64}$/.test(m.sha256);
  if (!configured) {
    return { name: 'inference model', status: 'warn', detail: `mirror not configured (base ${m.url})` };
  }
  return resolveClipModel()
    ? { name: 'inference model', status: 'ok', detail: `${m.version} (${m.installDir})` }
    : { name: 'inference model', status: 'warn', detail: 'not provisioned — run `shoots setup`' };
}

const CHECKS: ReadonlyArray<() => Promise<CheckResult>> = [
  checkPlatform,
  checkHome,
  checkTar,
  checkPerl,
  checkToolMirror,
  checkExiftool,
  checkLibraw,
  checkModel,
  checkSharp,
];

const SYMBOL: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

async function runDoctor(options: DoctorOptions): Promise<void> {
  const io = makeIo(options);
  const results: CheckResult[] = [];
  for (const check of CHECKS) results.push(await check());

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  if (io.json) {
    printJson({ command: 'doctor', home: shootsHome(), checks: results, summary: { failed, warned, total: results.length } });
  } else {
    for (const r of results) {
      printHuman(io, `[${SYMBOL[r.status]}] ${r.name.padEnd(12)} ${r.detail}`);
    }
    printHuman(io, `\n${results.length} checks: ${results.length - failed - warned} ok, ${warned} warnings, ${failed} failed`);
  }

  if (failed > 0) process.exitCode = 1;
}
