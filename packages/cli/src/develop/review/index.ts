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
import { page, type PageFrame } from './page.js';
import { FAMILIES, familyOf, selectFrames } from './select.js';
import type { LinearImage } from './pipeline.js';
import type { DevelopDataset, DevelopProfile } from '../types.js';
import { predictOne, resolveTreatment } from '../predict.js';
import { buildSessionContext, contextFor } from '../develop/session.js';
import { baseFeatures } from '../develop/assemble.js';

export interface ReviewOptions {
  port?: number;
  size?: number;
  onStatus?: (message: string) => void;
}

/** What the reviewer chose, per family. 1 leaves the fitted gain alone. */
export type Intensities = Record<string, number>;

interface Loaded {
  frame: PageFrame;
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
  for (const [i, pick] of picks.entries()) {
    status(`rendering preview ${i + 1}/${picks.length}`);
    try {
      const image = await decode(pick.record.file, size);
      const label = FAMILIES.find((f) => f.id === pick.family)?.label ?? 'Already close';
      loaded.push({
        frame: {
          id: i,
          label,
          ...(pick.family ? { family: pick.family } : {}),
          caption: pick.family
            ? `the strongest correction this control makes in your catalog`
            : 'inside the dead zone on every control — this one should hold still',
        },
        image,
        record: pick.record,
        sessionMean: contextFor(context, pick.record.file, baseFeatures(pick.record.embedding, pick.record.features, pick.record.asShot)),
      });
    } catch (e) {
      status(`skipped ${pick.record.file}: ${(e as Error).message}`);
    }
  }
  if (loaded.length === 0) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Intensities | null): void => {
      if (settled) return;
      settled = true;
      server.close();
      resolve(value);
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page(loaded.map((l) => l.frame), initial));
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
          const v = Number(url.searchParams.get(key));
          if (Number.isFinite(v)) intensities[key] = v;
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
      status(`review at http://localhost:${port} — save there, or press Ctrl-C to keep the fitted values`);
    });
    server.listen(wanted ?? 7391, '127.0.0.1');
    process.once('SIGINT', () => finish(null));
  });
}
