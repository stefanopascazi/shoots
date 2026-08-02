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
function lambdaSpread(lambdas: number[]): string {
  const counts = new Map<number, number>();
  for (const lambda of lambdas) counts.set(lambda, (counts.get(lambda) ?? 0) + 1);
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .map(([lambda, count]) => `${lambda}×${count}`)
    .join(' ');
}

function writeBranch(w: NodeJS.WritableStream, b: BranchModel, lambdaAuto: boolean, all: boolean): void {
  w.write(`\n  ── ${b.treatment.toUpperCase()} branch — ${b.samples} images in ${b.sessions} shoots ──\n`);
  const embedding = b.frame.embeddingFeatures === 0
    ? 'dropped'
    : b.frame.embeddingPca
      ? `${b.frame.embeddingFeatures} principal components`
      : `raw (${b.frame.embeddingFeatures} dims)`;
  w.write(`  CLIP embedding: ${embedding}\n`);
  w.write(`  level head: ${b.level.features} features describing the shoot (+${b.renderVocab.length} rendering)\n`);
  w.write(`  frame head: ${b.frame.features} features for how this frame departs from it\n`);
  w.write(`  λ per param${lambdaAuto ? ' (auto)' : ''}: level ${lambdaSpread(b.level.paramLambda)} | frame ${lambdaSpread(b.frame.paramLambda)}\n`);
  const gate = b.imageDependentSkill;
  const rand = b.imageDependentSkillRandom;
  w.write(`  image-dependent skill: ${gate === null ? 'n/a (too little data)' : gate.toFixed(4)}`);
  if (gate !== null && rand !== null) {
    w.write(`   (random folds: ${rand.toFixed(4)} — the gap is session leakage)`);
  }
  w.write('\n');
  // The number that separates a prediction from a default. Everything above can
  // look healthy on a model that only ever reproduces per-shoot averages.
  const within = b.withinSessionSkill;
  w.write(
    `  within-shoot skill: ${within === null ? 'n/a' : within.toFixed(4)}` +
      `   (does it tell two frames of the SAME shoot apart)\n`,
  );

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
    w.write('  param                end-end  ± fold   random    shoot  in-shoot  reach   model MAE\n');
    for (const p of rows) {
      const note = p.degenerate
        ? '  [never moves]'
        : p.gated
          ? '  [constant]'
          : p.frame.gated
            ? '  [flat within a shoot]'
            : '';
      w.write(
        `  ${p.key.padEnd(20)} ${pct(p.skill).padStart(7)} ${pct(p.skillSd).padStart(7)} ` +
          `${pct(p.skillRandom).padStart(8)} ` +
          `${pct(p.level.shippedSkill).padStart(8)} ${pct(p.frame.shippedSkill).padStart(9)} ` +
          `${p.frame.response.toFixed(2).padStart(6)} ${p.modelMae.toFixed(3).padStart(11)}${note}\n`,
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
    w.write(`  constant (both heads gated): ${b.gatedParams.length}/${b.perParam.length} params\n`);
  }
  if (b.flatParams.length > 0) {
    w.write(
      `  flat within a shoot: ${b.flatParams.length}/${b.perParam.length} params — a per-shoot level is predicted, ` +
        `but nothing tells one frame from another (in-shoot skill ≤ ${b.frameGateThreshold})\n`,
    );
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
  const described = profile.stats.described ?? profile.stats.edited;
  if (described > profile.stats.edited) {
    w.write(`  ${described} images describe their sessions; ${described - profile.stats.edited} carry no edit and are context only\n`);
  }
  w.write(`  ${profile.stats.edited} edited images: ${profile.stats.color} colour + ${profile.stats.bw} B&W (${args.folds}-fold CV, `);
  w.write(groupBy === 'folder' ? 'capture sessions held out)\n' : 'random folds — leakage-prone)\n');

  for (const treatment of ['color', 'bw'] as const) {
    const branch = profile.branches[treatment];
    if (branch) writeBranch(w, branch, lambda === undefined, args.all ?? false);
  }
  w.write('\n  end-end > 0 means the model beats "apply my average edit" on photographs\n');
  w.write('  from shoots it has never seen. "shoot" is how much of that comes from\n');
  w.write('  reading the shoot, "in-shoot" from reading THIS frame against its\n');
  w.write('  neighbours — and in-shoot is the one that decides whether a backlit\n');
  w.write('  frame and one in open shade come back with different numbers.\n');
  w.write('  "reach" is how far the prediction is stretched back out after ridge\n');
  w.write('  shrank it: 1.00 is untouched, above that the fit was too timid.\n');
  w.write('  "± fold" is how far end-end moves between held-out folds: a change\n');
  w.write('  smaller than it is not a change. Single per-parameter figures on a few\n');
  w.write('  hundred images routinely swing several points on their own.\n');
}
