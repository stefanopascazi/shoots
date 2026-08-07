/**
 * The `-stay_open` wire protocol, against a stand-in that reproduces exiftool's
 * framing byte for byte (see fixtures/fakeExiftool.mjs). The real binary is
 * exercised by the CLI's end-to-end suite; what needs isolating here is the
 * framing itself — payload boundaries, status demultiplexing, serialization and
 * what happens when the process dies mid-request.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import path from 'node:path';
import { ExiftoolDaemon } from '../src/tools/exiftoolDaemon.js';

const FAKE = path.join(import.meta.dir, 'fixtures', 'fakeExiftool.mjs');

const daemons: ExiftoolDaemon[] = [];

function makeDaemon(): ExiftoolDaemon {
  const daemon = new ExiftoolDaemon({ command: process.execPath, prefixArgs: [FAKE] });
  daemons.push(daemon);
  return daemon;
}

afterEach(async () => {
  await Promise.all(daemons.splice(0, daemons.length).map((d) => d.close()));
});

describe('ExiftoolDaemon.run', () => {
  test('returns a batch payload with its status', async () => {
    const daemon = makeDaemon();
    const result = await daemon.run(['-ver']);
    expect(result.stdout.toString('utf8')).toBe('13.59\r\n');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('reuses one process across calls', async () => {
    // Ids increment inside a single process; a respawn per call would still
    // pass the payload assertions, so the point is that both answers arrive at
    // all — a stale marker from a dead process would hang the second one.
    const daemon = makeDaemon();
    const first = await daemon.run(['-echoargs', 'a', 'b']);
    const second = await daemon.run(['-echoargs', 'c']);
    expect(first.stdout.toString('utf8')).toBe('a|b');
    expect(second.stdout.toString('utf8')).toBe('c');
  });

  test('carries binary output through untouched, with no trailing newline', async () => {
    // The -b case: raw bytes butt straight against the marker, and the payload
    // must come back byte-identical rather than newline-trimmed or re-encoded.
    const daemon = makeDaemon();
    const { stdout } = await daemon.run(['-bin']);
    expect(stdout.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(stdout[i]).toBe(i);
  });

  test('reassembles a payload that spans many chunks', async () => {
    // A full-size embedded preview arrives in 64KB pieces; every byte has to
    // survive the reassembly, and the request must still complete promptly.
    const daemon = makeDaemon();
    const { stdout } = await daemon.run(['-big']);
    expect(stdout.length).toBe(3 * 1024 * 1024);
    expect(stdout[0]).toBe(0);
    expect(stdout[1000]).toBe(1000 % 251);
    expect(stdout[stdout.length - 1]).toBe((3 * 1024 * 1024 - 1) % 251);
  });

  test('finds a marker split across chunk boundaries', async () => {
    // Searching only the newest chunk would never match a marker delivered one
    // byte at a time — hence the overlap carried between chunks.
    const daemon = makeDaemon();
    const { stdout, status } = await daemon.run(['-splitmarker']);
    expect(stdout.toString('utf8')).toBe('split\r\n');
    expect(status).toBe(0);
  });

  test('reports a non-zero status with the message that explains it', async () => {
    const daemon = makeDaemon();
    const result = await daemon.run(['-fail']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('File not found');
    expect(result.stdout.length).toBe(0);
  });

  test('keeps the output of a partly-failed batch alongside its status', async () => {
    // What `lenient` upstream depends on: one unreadable file in a batch of 500
    // must not throw away the 499 that read.
    const daemon = makeDaemon();
    const result = await daemon.run(['-partial']);
    expect(result.status).toBe(1);
    expect(result.stdout.toString('utf8')).toBe('partial\r\n');
    expect(result.stderr).toContain('File not found');
  });

  test('serializes concurrent calls instead of interleaving their replies', async () => {
    // One pipe, one marker stream: the slow batch must complete before the fast
    // one is even sent, or both payloads would arrive mixed on the same channel.
    const daemon = makeDaemon();
    const [slow, fast] = await Promise.all([
      daemon.run(['-echoargs', 'slow', '-slow']),
      daemon.run(['-echoargs', 'fast']),
    ]);
    expect(slow.stdout.toString('utf8')).toBe('slow|-slow');
    expect(fast.stdout.toString('utf8')).toBe('fast');
  });

  test('rejects an argument holding a newline rather than desynchronizing', async () => {
    // One arg per line is the whole protocol; a newline inside one would be read
    // as two arguments and every later marker would answer the wrong request.
    const daemon = makeDaemon();
    await expect(daemon.run(['-json', 'a\nb.cr3'])).rejects.toThrow(/newline/);
  });

  test('fails the in-flight call when the process dies, and recovers after', async () => {
    const daemon = makeDaemon();
    await expect(daemon.run(['-crash'])).rejects.toThrow(/exiftool/);
    // A fresh process serves the next call: a crash is not a permanent state.
    const after = await daemon.run(['-ver']);
    expect(after.stdout.toString('utf8')).toBe('13.59\r\n');
  });
});

describe('ExiftoolDaemon.matches', () => {
  test('is true only for the same binary and prefix args', () => {
    const daemon = new ExiftoolDaemon({ command: 'perl', prefixArgs: ['/a/exiftool'] });
    expect(daemon.matches({ command: 'perl', prefixArgs: ['/a/exiftool'] })).toBe(true);
    expect(daemon.matches({ command: 'perl', prefixArgs: ['/b/exiftool'] })).toBe(false);
    expect(daemon.matches({ command: '/a/exiftool', prefixArgs: [] })).toBe(false);
    expect(daemon.matches({ command: 'perl', prefixArgs: ['/a/exiftool', '-x'] })).toBe(false);
  });
});

describe('ExiftoolDaemon.close', () => {
  test('is idempotent and leaves the daemon usable again', async () => {
    const daemon = makeDaemon();
    await daemon.run(['-ver']);
    await daemon.close();
    await daemon.close();
    const again = await daemon.run(['-ver']);
    expect(again.stdout.toString('utf8')).toBe('13.59\r\n');
  });
});
