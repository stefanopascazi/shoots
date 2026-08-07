/** Digest handling for the pinned tool/model mirror. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeSha256, sha256File } from '../src/checksum.js';

const HEX = /^[0-9a-f]{64}$/;
const dir = await mkdtemp(path.join(tmpdir(), 'shoots-checksum-'));

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('normalizeSha256', () => {
  const digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  test('strips the algorithm prefix in either spelling', () => {
    expect(normalizeSha256(`sha256:${digest}`)).toBe(digest);
    expect(normalizeSha256(`sha-256:${digest}`)).toBe(digest);
    expect(normalizeSha256(`SHA256:${digest}`)).toBe(digest);
  });

  test('lowercases and trims, so the result always matches the validation regex', () => {
    expect(normalizeSha256(`  SHA256: ${digest.toUpperCase()}  `)).toBe(digest);
    expect(HEX.test(normalizeSha256(`sha256:${digest.toUpperCase()}`))).toBe(true);
  });

  test('leaves an already-bare digest untouched', () => {
    expect(normalizeSha256(digest)).toBe(digest);
  });
});

describe('sha256File', () => {
  test('matches the known digest of the empty file', async () => {
    const file = path.join(dir, 'empty.bin');
    await writeFile(file, '');
    expect(await sha256File(file)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  test('matches the known digest of "abc"', async () => {
    const file = path.join(dir, 'abc.bin');
    await writeFile(file, 'abc');
    expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  test('digests binary content the same as node:crypto would', async () => {
    const { createHash } = await import('node:crypto');
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    const file = path.join(dir, 'blob.bin');
    await writeFile(file, bytes);
    expect(await sha256File(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  test('rejects rather than resolving when the file is missing', async () => {
    expect(sha256File(path.join(dir, 'nope.bin'))).rejects.toThrow();
  });
});
