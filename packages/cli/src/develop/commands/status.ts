/**
 * `develop status` — what this machine currently holds.
 *
 * The pipeline hides its paths on purpose, which means there is no longer an
 * obvious place to look when you want to know whether a profile exists, how old
 * it is, or what `develop clean` is about to delete. This is that place.
 */
import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { developExportPath, developFeedbackPath, developProfilePath, developShootsDir } from '@shoots/core';
import { loadJournal, shootCount } from '../feedback/journal.js';
import { makeIo, printHuman, printJson } from '../../io.js';
import type { DevelopProfile } from '../types.js';

export interface StatusArgs {
  json?: boolean;
  verbose?: boolean;
}

const human = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB`
  : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB`
  : `${Math.max(1, Math.round(bytes / 1e3))} kB`;

const age = (iso: string): string => {
  const days = (Date.now() - Date.parse(iso)) / 86400000;
  if (!Number.isFinite(days)) return 'unknown';
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  return `${Math.floor(days)} days ago`;
};

export async function runStatus(args: StatusArgs): Promise<void> {
  const io = makeIo(args);
  const datasetPath = developExportPath();
  const profilePath = developProfilePath();
  const shootsDir = developShootsDir();

  const datasetBytes = existsSync(datasetPath) ? (await stat(datasetPath)).size : 0;
  let profile: DevelopProfile | null = null;
  if (existsSync(profilePath)) {
    try {
      profile = JSON.parse(await readFile(profilePath, 'utf8')) as DevelopProfile;
    } catch {
      profile = null;
    }
  }
  const shoots = existsSync(shootsDir) ? await readdir(shootsDir) : [];
  const journalPath = developFeedbackPath();
  const journal = await loadJournal(journalPath);

  if (io.json) {
    printJson({
      command: 'develop-status',
      dataset: { path: datasetPath, exists: datasetBytes > 0, bytes: datasetBytes },
      profile: profile
        ? {
            path: profilePath, name: profile.name, trainedAt: profile.trainedAt,
            baseline: profile.baseline, stats: profile.stats,
            skill: Object.fromEntries(
              Object.entries(profile.branches).map(([t, b]) => [t, b?.imageDependentSkill ?? null]),
            ),
          }
        : { path: profilePath, exists: false },
      shoots,
      journal: { path: journalPath, images: journal.length, shoots: shootCount(journal) },
    });
    return;
  }

  printHuman(io, `\nTraining dataset  ${datasetBytes > 0 ? `${human(datasetBytes)}  ${datasetPath}` : 'none yet'}`);
  if (profile) {
    printHuman(io, `Profile           '${profile.name}', trained ${age(profile.trainedAt)}, baseline ${profile.baseline}`);
    printHuman(io, `                  ${profile.stats.edited} edited images (${profile.stats.color} colour + ${profile.stats.bw} B&W)`);
    for (const treatment of ['color', 'bw'] as const) {
      const branch = profile.branches[treatment];
      if (!branch) continue;
      const skill = branch.imageDependentSkill;
      const gated = branch.gatedParams.length;
      printHuman(
        io,
        `                  ${treatment.padEnd(5)} skill ${skill === null ? 'n/a' : skill.toFixed(4)}, ` +
          `${gated}/${branch.perParam.length} params gated to your constant`,
      );
    }
  } else {
    printHuman(io, `Profile           none — run \`shoots develop init <catalog>\``);
  }

  // The journal only grows, and only `develop feedback` grows it — so how far it
  // has got is the one number telling you whether the per-parameter breakdown is
  // worth reading yet.
  printHuman(
    io,
    `\nFeedback journal  ${journal.length > 0 ? `${journal.length} images from ${shootCount(journal)} shoots` : 'empty — run `shoots develop feedback` after developing a shoot'}`,
  );

  printHuman(io, `\nCached shoots     ${shoots.length}${shoots.length ? ` in ${shootsDir}` : ''}`);
  for (const name of shoots.slice(0, 10)) printHuman(io, `                  ${name}`);
  if (shoots.length > 10) printHuman(io, `                  … and ${shoots.length - 10} more`);
  if (shoots.length > 0) printHuman(io, '\n`shoots develop clean` removes the cached shoots; the profile and journal survive.');
}
