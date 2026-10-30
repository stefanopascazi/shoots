/**
 * `develop style train | list` — detail profiles on top of the general one.
 *
 * `train` takes a dataset of edits that share a style (exported like any
 * training set), predicts each frame with the general profile, and keeps how the
 * photographer departed from it. `list` shows the styles saved under
 * `~/.shoots/develop/styles`.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { developProfilePath, developStylesDir } from '@shoots/core';
import { assertApplicable, predictOne, resolveTreatment } from '../predict.js';
import { loadDataset } from '../dataset/load.js';
import { baseFeatures } from '../develop/assemble.js';
import { buildSessionContext, contextFor, sessionKey } from '../develop/session.js';
import { paramsForTreatment, type Treatment } from '../develop/schema.js';
import { toCorrectionSpace } from '../feedback/calibrate.js';
import { fitStyleBranch, resolveStylePath, validStyleName, type DevelopStyle, type StyleObservation } from '../style/style.js';
import { logError, makeIo, printHuman, printJson } from '../../io.js';
import { VERSION } from '../../version.js';
import type { DevelopProfile } from '../types.js';

export interface StyleTrainArgs {
  name: string;
  data: string;
  profile?: string;
  out?: string;
  description?: string;
  json?: boolean;
  verbose?: boolean;
}

export async function runStyleTrain(args: StyleTrainArgs): Promise<void> {
  const io = makeIo(args);
  if (!validStyleName(args.name)) {
    logError(`invalid style name '${args.name}' — letters, digits, space, '.', '_' or '-', up to 64 characters`);
    process.exitCode = 2;
    return;
  }
  const profilePath = path.resolve(args.profile ?? developProfilePath());
  if (!existsSync(profilePath)) {
    logError(`no general profile at ${profilePath} — a style is measured against it; train one first or pass --profile`);
    process.exitCode = 2;
    return;
  }
  const profile = JSON.parse(await readFile(profilePath, 'utf8')) as DevelopProfile;
  const dataset = await loadDataset(args.data);
  assertApplicable(profile, dataset);

  // Session context from every record, edited or not — the general profile reads
  // a frame against its shoot, so the style must see the frame the same way.
  const usable = dataset.results.filter((r) => r.embedding?.length && r.features?.length);
  const base = new Map(usable.map((r) => [r.file, baseFeatures(r.embedding, r.features, r.asShot)]));
  const context = buildSessionContext(usable.map((r) => ({ file: r.file, features: base.get(r.file)! })));

  const observations: Partial<Record<Treatment, StyleObservation[]>> = {};
  for (const r of usable) {
    if (r.edited === false) continue;
    const treatment = resolveTreatment(profile, r, 'auto');
    // A frame whose treatment the general profile has no branch for has nothing to depart from.
    if (treatment !== (r.treatment ?? 'color')) continue;
    const predicted = predictOne(profile, r, treatment, contextFor(context, r.file, base.get(r.file)!)).develop;
    const residuals: Record<string, number> = {};
    for (const p of paramsForTreatment(treatment)) {
      const kept = r.develop[p.key];
      const pred = predicted[p.key];
      if (kept === undefined || pred === undefined) continue;
      residuals[p.key] = toCorrectionSpace(p, kept) - toCorrectionSpace(p, pred);
    }
    (observations[treatment] ??= []).push({ shoot: sessionKey(r.file), residuals });
  }

  const style: DevelopStyle = {
    type: 'develop-style',
    name: args.name,
    ...(args.description ? { description: args.description } : {}),
    base: { name: profile.name, trainedAt: profile.trainedAt },
    trainedAt: new Date().toISOString(),
    toolVersion: VERSION,
    branches: {},
  };
  for (const [t, obs] of Object.entries(observations) as [Treatment, StyleObservation[]][]) {
    if (obs.length) style.branches[t] = fitStyleBranch(obs, t);
  }
  if (!Object.keys(style.branches).length) {
    logError(`no edited frames in ${args.data} that the general profile can predict — nothing to learn a style from`);
    process.exitCode = 2;
    return;
  }

  const out = path.resolve(args.out ?? resolveStylePath(args.name));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(style, null, 2) + '\n', 'utf8');

  if (io.json) {
    printJson({ command: 'develop-style-train', style: args.name, out, base: style.base, branches: style.branches });
    return;
  }
  printHuman(io, `Style '${args.name}' on top of '${profile.name}' → ${out}`);
  for (const [t, b] of Object.entries(style.branches)) {
    printHuman(io, `\n${t}: ${b!.images} photographs from ${b!.shoots} shoot(s)`);
    const moved = Object.entries(b!.params)
      .filter(([, p]) => Math.abs(p.offset) > 1e-6)
      .sort((a, b2) => Math.abs(b2[1].offset / (b2[1].se || 1)) - Math.abs(a[1].offset / (a[1].se || 1)));
    if (!moved.length) {
      printHuman(io, '  no parameter departs consistently from the general profile');
      continue;
    }
    for (const [key, p] of moved.slice(0, 12)) {
      const sign = p.offset >= 0 ? '+' : '';
      printHuman(io, `  ${key.padEnd(28)} ${sign}${p.offset.toFixed(3)}  (measured ${p.mean.toFixed(3)} ± ${p.se.toFixed(3)}, kept ${Math.round(p.shrink * 100)}%)`);
    }
    if (moved.length > 12) printHuman(io, `  … and ${moved.length - 12} more`);
  }
  if (Object.values(style.branches).some((b) => b!.shoots < 3)) {
    printHuman(io, '\nFewer than three shoots: only departures that hold across every frame survive. More shoots sharpen it.');
  }
}

export interface StyleListArgs {
  json?: boolean;
  verbose?: boolean;
}

export async function runStyleList(args: StyleListArgs): Promise<void> {
  const io = makeIo(args);
  const dir = developStylesDir();
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.json')).sort() : [];
  const styles: DevelopStyle[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as DevelopStyle;
      if (s.type === 'develop-style') styles.push(s);
    } catch {
      // A file that is not a style is not ours to list.
    }
  }
  if (io.json) {
    printJson({
      command: 'develop-style-list',
      dir,
      styles: styles.map((s) => ({
        name: s.name,
        description: s.description,
        base: s.base,
        trainedAt: s.trainedAt,
        branches: Object.fromEntries(Object.entries(s.branches).map(([t, b]) => [t, { images: b!.images, shoots: b!.shoots }])),
      })),
    });
    return;
  }
  if (!styles.length) {
    printHuman(io, `No styles in ${dir} — \`shoots develop style train --name <name> --data <export.jsonl>\` makes one.`);
    return;
  }
  for (const s of styles) {
    const counts = Object.entries(s.branches).map(([t, b]) => `${t} ${b!.images} photos / ${b!.shoots} shoots`).join(', ');
    printHuman(io, `${s.name.padEnd(24)} on '${s.base.name}'  ${counts}${s.description ? `  — ${s.description}` : ''}`);
  }
}
