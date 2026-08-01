/**
 * Which version of shoots built what is currently sitting in `~/.shoots`.
 *
 * The question `release-notes` answers is "does the state on this machine still
 * match the running tool", so the reference point is the artefacts, not a
 * "notes last seen" marker: acknowledging a note does not rebuild a profile.
 *
 * Artefacts written before the stamp existed carry no version. That is not
 * missing data — it dates them to 0.4.8 or earlier, i.e. before every entry in
 * {@link MIGRATIONS}, which is exactly the answer needed.
 */
import { existsSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { developExportPath, developProfilePath } from '@shoots/core';
import { VERSION } from '../version.js';

export interface ArtifactStamp {
  kind: 'profile' | 'dataset';
  path: string;
  /** Null when the artefact predates the stamp (0.4.8 or earlier). */
  version: string | null;
}

/** The version stamp written into every profile and dataset by this build. */
export const toolStamp = (): string => VERSION;

/**
 * Read the meta line of a develop dataset without loading the file.
 *
 * The dataset is JSONL and can run to hundreds of MB; the meta line is the last
 * one written, so a tail read is enough. Legacy exports are a single pretty
 * JSON object with no trailing meta line — those predate the stamp anyway, so
 * failing to find one and returning null is the correct answer, not a fallback.
 */
async function datasetToolVersion(file: string): Promise<string | null> {
  const TAIL_BYTES = 64 * 1024;
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{') || !line.includes('"develop-meta"')) continue;
      try {
        const meta = JSON.parse(line) as { _type?: string; toolVersion?: string };
        if (meta._type === 'develop-meta') return meta.toolVersion ?? null;
      } catch {
        // A truncated first line of the tail window: keep looking backwards.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function profileToolVersion(file: string): Promise<string | null> {
  try {
    const profile = JSON.parse(await readFile(file, 'utf8')) as { toolVersion?: string };
    return profile.toolVersion ?? null;
  } catch {
    return null;
  }
}

/** Every develop artefact present on this machine, with the version that built it. */
export async function readArtifactStamps(): Promise<ArtifactStamp[]> {
  const stamps: ArtifactStamp[] = [];
  const profile = developProfilePath();
  if (existsSync(profile)) {
    stamps.push({ kind: 'profile', path: profile, version: await profileToolVersion(profile) });
  }
  const dataset = developExportPath();
  if (existsSync(dataset)) {
    let version: string | null = null;
    try {
      version = await datasetToolVersion(dataset);
    } catch {
      version = null;
    }
    stamps.push({ kind: 'dataset', path: dataset, version });
  }
  return stamps;
}
