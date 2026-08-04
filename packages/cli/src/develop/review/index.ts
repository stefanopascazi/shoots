/**
 * `develop train --review` — set the anchored corrections' intensity by eye.
 *
 * The one number in this model that measurement could not supply. An anchored
 * slider's gain is a property of the *shoot*, not of the photographer: fitted
 * inside each shoot separately it runs from −4.2 to +0.3 where the global fit
 * says −1.0, and nothing predicts which a new shoot wants. Five shoot-level
 * photometric descriptors correlate at best −0.33 and lose to the global gain in
 * leave-one-shoot-out; the shoot's mean CLIP embedding does no better on
 * exposure. Two independent catalogs agree, and the ceiling they leave on the
 * table is 30–57%.
 *
 * So it is not predicted, it is asked — once per profile, at the moment the
 * profile is made, on the frames where the answer is visible.
 *
 * Every answer is also an observation: "on this catalog the photographer wanted
 * 2.2". Enough of those across enough profiles is a clean, direct label for the
 * quantity that today can only be derived indirectly from past edits — which is
 * how this screen eventually makes itself unnecessary.
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { decode, renderPreview } from './preview.js';
import { rawPixels } from '@shoots/imaging';
import { page, type PageStep } from './page.js';
import { FAMILIES, familyOf, selectFrames } from './select.js';
import type { LinearImage } from './pipeline.js';
import type { DevelopDataset, DevelopProfile } from '../types.js';
import { predictOne, resolveTreatment } from '../predict.js';
import { buildSessionContext, contextFor } from '../develop/session.js';
import { baseFeatures } from '../develop/assemble.js';
import { paramsForTreatment } from '../develop/schema.js';

export interface ReviewOptions {
  port?: number;
  size?: number;
  /**
   * Minutes to wait for somebody to open the page and save. 0 waits forever.
   *
   * This screen is the one interactive step in a tool that is otherwise entirely
   * unattended, and `shoots pipeline` runs its steps as child processes with
   * stdin ignored — so a pipeline of `train --review` followed by `edit` would
   * sit on the review forever and never reach the edit. Nothing would be wrong;
   * it would simply never finish, which is the worst way for a batch job to
   * fail. Giving up and keeping the fitted values is a correct profile, so the
   * wait is bounded by default and the deadline is stated up front.
   */
  timeoutMinutes?: number;
  onStatus?: (message: string) => void;
}

/** What the reviewer chose, per family. 1 leaves the fitted gain alone. */
export type Intensities = Record<string, number>;

const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

interface Loaded {
  image: LinearImage;
  record: DevelopDataset['results'][number];
  sessionMean: number[];
}

/**
 * Scale every anchor of every branch by its family's multiplier, in place.
 *
 * Applied to the profile *after* it is fitted and scored, so the skills stored
 * on each anchor keep describing the gain as measured. The multiplier is a taste
 * decision taken on top of the evidence, not a correction to it.
 */
export function applyIntensities(profile: DevelopProfile, intensities: Intensities): void {
  for (const branch of Object.values(profile.branches)) {
    if (!branch?.anchors) continue;
    for (const [key, anchor] of Object.entries(branch.anchors)) {
      const family = familyOf(key);
      const scale = family ? intensities[family] : undefined;
      if (scale === undefined || scale === 1) continue;
      anchor.gain *= scale;
      if (anchor.gainBelow !== undefined) anchor.gainBelow *= scale;
    }
  }
}

/** Families that have at least one anchor to scale, with 1 as the starting point. */
function activeFamilies(profile: DevelopProfile): Intensities {
  const out: Intensities = {};
  for (const branch of Object.values(profile.branches)) {
    for (const key of Object.keys(branch?.anchors ?? {})) {
      const family = familyOf(key);
      if (family) out[family] = 1;
    }
  }
  return out;
}

/**
 * Open the review screen and resolve with what the reviewer chose.
 *
 * Resolves with `null` when there is nothing to review — no anchors, or no RAW
 * still on disk to render — so the caller can write the profile unchanged rather
 * than treating it as a failure.
 */
export async function review(
  profile: DevelopProfile,
  dataset: DevelopDataset,
  options: ReviewOptions = {},
): Promise<Intensities | null> {
  const status = options.onStatus ?? ((): void => {});
  const initial = activeFamilies(profile);
  if (Object.keys(initial).length === 0) return null;

  // Only frames whose RAW is still where the export found it can be previewed.
  const available = dataset.results.filter((r) => r.features?.length && existsSync(r.file));
  if (available.length === 0) {
    status('none of the exported RAWs are still on disk — skipping review');
    return null;
  }

  const anchors = Object.assign({}, ...Object.values(profile.branches).map((b) => b?.anchors ?? {}));
  const picks = selectFrames(available, anchors);
  if (picks.length === 0) return null;

  // The session mean each frame is predicted against, built from every record
  // exactly as training did — a frame previewed against a different context
  // would not be the frame the profile will actually produce.
  const context = buildSessionContext(
    dataset.results
      .filter((r) => r.embedding?.length && r.features?.length)
      .map((r) => ({ file: r.file, features: baseFeatures(r.embedding, r.features, r.asShot) })),
  );

  const size = options.size ?? 900;
  const loaded: Loaded[] = [];
  const stepsFor: { pick: (typeof picks)[number]; index: number }[] = [];
  for (const pick of picks) {
    if (!pick.family) continue; // the control frame has no slider of its own
    status(`rendering preview ${loaded.length + 1}`);
    try {
      const image = await decode(pick.record.file, size);
      stepsFor.push({ pick, index: loaded.length });
      loaded.push({
        image,
        record: pick.record,
        sessionMean: contextFor(context, pick.record.file, baseFeatures(pick.record.embedding, pick.record.features, pick.record.asShot)),
      });
    } catch (e) {
      status(`skipped ${pick.record.file}: ${(e as Error).message}`);
    }
  }
  if (loaded.length === 0) return null;

  /** Render one frame with one family scaled, as the reviewer would see it. */
  const renderAt = async (item: Loaded, family: string, scale: number): Promise<Buffer> => {
    const scaled = structuredClone(profile);
    applyIntensities(scaled, { ...initial, [family]: scale });
    const treatment = resolveTreatment(scaled, item.record, 'auto');
    const prediction = predictOne(scaled, item.record, treatment, item.sessionMean);
    return renderPreview(item.image, prediction.develop, item.record.asShot);
  };

  /**
   * How much the picture actually changes between the control off and as fitted.
   *
   * Mean absolute difference over the encoded pixels, as a fraction of full
   * scale. Cheap, and it answers the only question that matters here: would a
   * photographer see this slider do anything.
   */
  const visibleChange = async (item: Loaded, family: string): Promise<number> => {
    const [a, b] = await Promise.all([renderAt(item, family, 0), renderAt(item, family, 1)]);
    const [pa, pb] = await Promise.all([rawPixels(a), rawPixels(b)]);
    const n = Math.min(pa.length, pb.length);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.abs(pa[i]! - pb[i]!);
    return sum / n / 255;
  };

  /** What one parameter lands on for a frame, with one family scaled by `scale`. */
  const valueAt = (item: Loaded, family: string, param: string, scale: number): number => {
    const scaled = structuredClone(profile);
    applyIntensities(scaled, { ...initial, [family]: scale });
    const treatment = resolveTreatment(scaled, item.record, 'auto');
    return predictOne(scaled, item.record, treatment, item.sessionMean).develop[param] ?? 0;
  };

  // A step per family, labelled in the parameter's own units. A family whose
  // frame does not actually move between "off" and "as fitted" is dropped rather
  // than shown as a control that does nothing — which is what Presence was
  // before Dehaze reached the preview at all.
  const pageSteps: PageStep[] = [];
  for (const { pick, index } of stepsFor) {
    const family = FAMILIES.find((f) => f.id === pick.family);
    if (!family) continue;
    const item = loaded[index]!;
    const zero = valueAt(item, family.id, family.shownAs, 0);
    const fitted = valueAt(item, family.id, family.shownAs, 1);
    // Whether the control is reviewable is a question about the *picture*, not
    // about the parameter. A span that looks respectable in slider units can be
    // invisible on screen — and worse, a family scales several parameters at
    // once, so two of them with opposite gains cancel and the frame does not
    // move at all however far the slider travels. Highlights does exactly that
    // here: it scales Highlights2012 at −32.7 together with Whites2012 at +177,
    // and the rendered p99 changes by 4% across the whole range.
    //
    // So the test is a render at each end, compared. Offering a control that
    // visibly does nothing is worse than offering none: it reads as broken.
    const change = await visibleChange(item, family.id);
    if (change < 0.02) {
      status(`${family.label}: moving it changes the picture by ${(change * 100).toFixed(1)}% — not reviewable, skipping it`);
      continue;
    }
    const span = fitted - zero;
    const far = zero + span * 3;
    pageSteps.push({
      id: index,
      family: family.id,
      label: family.label,
      caption: 'the photograph in your catalog this control changes the most',
      unit: family.unit,
      decimals: family.decimals,
      zero: round(zero, family.decimals),
      fitted: round(fitted, family.decimals),
      min: round(Math.min(zero, far), family.decimals),
      max: round(Math.max(zero, far), family.decimals),
    });
  }
  if (pageSteps.length === 0) {
    status('none of the anchored controls change anything on these frames — nothing to review');
    return null;
  }

  const timeoutMinutes = options.timeoutMinutes ?? 10;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: Intensities | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      resolve(value);
    };
    if (timeoutMinutes > 0) {
      timer = setTimeout(() => {
        status(`nobody opened the review in ${timeoutMinutes} minutes — keeping the fitted intensities`);
        // The recovery path, on the line where it is needed. Behind this screen
        // there may be hours of export and fit, and nothing about the profile
        // just written says the calibration is still available without redoing
        // any of it.
        status('  re-open it any time — no refit — with:  shoots develop calibrate --review');
        finish(null);
      }, timeoutMinutes * 60_000);
      // Not a reason to hold the process open on its own: if everything else has
      // finished, the wait is over whatever the clock says.
      timer.unref();
    }

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(pageSteps));
        return;
      }
      if (url.pathname === '/save' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Intensities;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          finish(body);
        } catch {
          res.writeHead(400);
          res.end();
        }
        return;
      }
      const match = /^\/frame\/(\d+)$/.exec(url.pathname);
      if (match) {
        const item = loaded[Number(match[1])];
        if (!item) {
          res.writeHead(404);
          res.end();
          return;
        }
        // Re-predict at the requested intensities. The profile is cloned per
        // request rather than mutated, so a half-finished slider drag can never
        // leave a scaled anchor behind in the object that gets written out.
        const scaled = structuredClone(profile);
        const intensities: Intensities = { ...initial };
        for (const key of Object.keys(initial)) {
          // `Number(null)` is 0 and `Number.isFinite(0)` is true, so testing the
          // parsed value alone turns every *absent* parameter into a ×0 — which
          // is how the very first render, before any slider has been touched,
          // came back with every anchor switched off.
          const raw = url.searchParams.get(key);
          if (raw === null) continue;
          const v = Number(raw);
          if (Number.isFinite(v) && v >= 0) intensities[key] = v;
        }
        applyIntensities(scaled, intensities);
        const treatment = resolveTreatment(scaled, item.record, 'auto');
        const prediction = predictOne(scaled, item.record, treatment, item.sessionMean);
        const jpeg = await renderPreview(item.image, prediction.develop, item.record.asShot);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
        res.end(jpeg);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    // The port is an implementation detail unless the caller named one: if 7391
    // is taken — another shoots review, a dev server, anything — asking the OS
    // for a free one is what the photographer wanted anyway. A named port is a
    // different promise, so that one fails loudly instead of moving silently.
    const wanted = options.port;
    let retried = false;
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE' && wanted === undefined && !retried) {
        retried = true;
        server.listen(0, '127.0.0.1');
        return;
      }
      status(
        e.code === 'EADDRINUSE'
          ? `port ${wanted} is already in use — pass a free --review-port, or omit it to let one be chosen`
          : `could not open the review page: ${e.message}`,
      );
      finish(null);
    });
    server.on('listening', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : wanted;
      const deadline = timeoutMinutes > 0 ? ` or waiting ${timeoutMinutes} min` : '';
      status(`review at http://localhost:${port}`);
      status(`  save there to apply — pressing Ctrl-C${deadline} keeps the fitted values`);
    });
    server.listen(wanted ?? 7391, '127.0.0.1');
    process.once('SIGINT', () => finish(null));
  });
}
