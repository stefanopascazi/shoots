/**
 * `develop train` — fit and export a per-catalog develop profile.
 *
 * The report is the product here: it is the evidence a photographer decides on.
 * It shows the gate skill (capture sessions held out) next to the random-fold
 * skill, because the gap between them is how much of an encouraging number is
 * really the model recognising frames from a shoot it already saw.
 */
import { writeFile } from 'node:fs/promises';
import { train } from '../train/train.js';
import { GROUP_BY_MODES, type GroupBy } from '../train/evaluate.js';
import { loadDataset } from '../dataset/load.js';
import type { BranchModel } from '../types.js';

export interface TrainArgs {
  data: string;
  name: string;
  out: string;
  /** 'auto' (cross-validated) or a numeric ridge strength. */
  lambda: string;
  folds: number;
  groupBy?: string;
  gateThreshold?: number;
  /** CLIP components to keep: 0 drops the embedding, high values keep it raw. */
  embeddingDim?: number;
  /** Report every parameter, not just the image-dependent ones. */
  all?: boolean;
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/**
 * How the per-parameter λ came out, most-used first — e.g. `30000×61 1000×12`.
 *
 * Worth a line of its own: everything piling onto the top of the grid is the
 * signature of a catalog the model cannot read, and it is the difference between
 * "the predictions are flat" and knowing *why* they are flat.
 */
function lambdaSpread(b: BranchModel): string {
  const counts = new Map<number, number>();
  for (const lambda of b.paramLambda) counts.set(lambda, (counts.get(lambda) ?? 0) + 1);
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .map(([lambda, count]) => `${lambda}×${count}`)
    .join(' ');
}

function writeBranch(w: NodeJS.WritableStream, b: BranchModel, lambdaAuto: boolean, all: boolean): void {
  w.write(`\n  ── ${b.treatment.toUpperCase()} branch — ${b.samples} images ──\n`);
  const embedding = b.embeddingFeatures === 0
    ? 'dropped'
    : b.embeddingPca
      ? `${b.embeddingFeatures} principal components`
      : `raw (${b.embeddingFeatures} dims)`;
  w.write(`  CLIP embedding: ${embedding}\n`);
  w.write(
    b.sessionFeatures > 0
      ? `  session context: ${b.sessionFeatures} features describing each image's whole shoot\n`
      : `  session context: off — too few images in this branch to afford it\n`,
  );
  w.write(`  λ per param${lambdaAuto ? ' (auto)' : ''}: ${lambdaSpread(b)}\n`);
  const gate = b.imageDependentSkill;
  const rand = b.imageDependentSkillRandom;
  w.write(`  image-dependent skill: ${gate === null ? 'n/a (too little data)' : gate.toFixed(4)}`);
  if (gate !== null && rand !== null) {
    w.write(`   (random folds: ${rand.toFixed(4)} — the gap is session leakage)`);
  }
  w.write('\n');

  // Image-dependent params always; the rest only on request. Degenerate targets
  // are listed too — a target that never moves is evidence about the *export*,
  // and hiding it is how a misread tag stays hidden.
  //
  // The tone curve is shown regardless of its weight. It is a major style
  // vehicle (on a black-and-white edit it *is* the look), so burying it in the
  // "not shown" tail would hide the one block a photographer most wants to check
  // — while keeping it out of the headline, which measures image-dependence.
  const shown = b.perParam.filter((p) => all || p.weight >= 1.5 || p.group === 'toneCurve');
  const rows = shown.slice().sort((x, y) => y.skill - x.skill);
  if (rows.length > 0) {
    w.write('  param                 skill   random    model MAE   baseline MAE        λ\n');
    for (const p of rows) {
      const note = p.degenerate ? '  [never moves]' : p.gated ? '  [gated → constant]' : '';
      w.write(
        `  ${p.key.padEnd(20)} ${pct(p.skill).padStart(7)} ${pct(p.skillRandom).padStart(8)} ` +
          `${p.modelMae.toFixed(3).padStart(12)} ${p.baselineMae.toFixed(3).padStart(14)} ` +
          `${String(p.lambda).padStart(8)}${note}\n`,
      );
    }
  }
  if (!all) {
    const hidden = b.perParam.filter((p) => p.weight < 1.5 && p.group !== 'toneCurve');
    const negative = hidden.filter((p) => p.skill < 0).length;
    if (hidden.length > 0) {
      w.write(`  … ${hidden.length} style params not shown (${negative} with negative skill) — pass --all\n`);
    }
  }
  if (b.gatedParams.length > 0) {
    w.write(`  gated (predicted as your constant): ${b.gatedParams.length}/${b.perParam.length} params at skill ≤ ${b.gateThreshold}\n`);
  }
}

export async function runTrain(args: TrainArgs): Promise<void> {
  const dataset = await loadDataset(args.data);
  const lambda = args.lambda === 'auto' ? undefined : parseFloat(args.lambda);
  if (lambda !== undefined && !Number.isFinite(lambda)) throw new Error(`invalid --lambda '${args.lambda}' (use a number or 'auto')`);

  const groupBy = (args.groupBy ?? 'folder') as GroupBy;
  if (!GROUP_BY_MODES.includes(groupBy)) {
    throw new Error(`invalid --group-by '${args.groupBy}' (use ${GROUP_BY_MODES.join(' | ')})`);
  }

  const profile = train(dataset, {
    name: args.name,
    lambda,
    folds: args.folds,
    groupBy,
    gateThreshold: args.gateThreshold,
    embeddingDim: args.embeddingDim,
  });
  await writeFile(args.out, JSON.stringify(profile, null, 2) + '\n', 'utf8');

  const w = process.stderr;
  w.write(`\nDevelop profile '${profile.name}' → ${args.out}\n`);
  w.write(`  ${profile.stats.edited} edited images: ${profile.stats.color} colour + ${profile.stats.bw} B&W (${args.folds}-fold CV, `);
  w.write(groupBy === 'folder' ? 'capture sessions held out)\n' : 'random folds — leakage-prone)\n');

  for (const treatment of ['color', 'bw'] as const) {
    const branch = profile.branches[treatment];
    if (branch) writeBranch(w, branch, lambda === undefined, args.all ?? false);
  }
  w.write('\n  skill > 0 means the model beats "apply my average edit" on photographs\n');
  w.write('  from shoots it has never seen. That is the number that decides.\n');
}
