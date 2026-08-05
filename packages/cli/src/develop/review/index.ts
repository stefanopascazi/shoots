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
 *
 * **The server predicts; the browser renders.** It decodes each RAW once, sends
 * the scene-linear buffer and a ramp of predictions, and answers nothing else.
 * Every pixel the reviewer sees is produced on the GPU by `glsl.ts` — which is
 * what makes a slider move at the speed of a hand, and what lets local-contrast
 * controls exist on this screen at all.
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decode } from './preview.js';
import { page, type PageStep } from './page.js';
import { buildRamp, MAX_SCALE } from './ramp.js';
import { activeFamilies, intensityKey, type Intensities } from './intensities.js';
import { FAMILIES, selectFrames } from './select.js';
import type { LinearImage } from './color.js';
import type { Ramp } from './client.js';
import type { DevelopDataset, DevelopProfile } from '../types.js';
import { resolveTreatment } from '../predict.js';
import { buildSessionContext, contextFor } from '../develop/session.js';
import { baseFeatures } from '../develop/assemble.js';

/** The branches a profile can carry, and what to call them on screen. */
const TREATMENTS = ['color', 'bw'] as const;
const TREATMENT_LABEL: Record<string, string> = { color: 'colour', bw: 'black-and-white' };

export { applyIntensities, describeIntensities, type Intensities } from './intensities.js';

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

const round = (v: number, decimals: number): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

interface Loaded {
  image: LinearImage;
  ramp: Ramp;
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

  // The session mean each frame is predicted against, built from every record
  // exactly as training did — a frame previewed against a different context
  // would not be the frame the profile will actually produce.
  const context = buildSessionContext(
    dataset.results
      .filter((r) => r.embedding?.length && r.features?.length)
      .map((r) => ({ file: r.file, features: baseFeatures(r.embedding, r.features, r.asShot) })),
  );

  /**
   * One group of frames per treatment, each judged on its own photographs.
   *
   * Merging the branches' anchors and picking from the whole catalog was wrong
   * twice: `Object.assign` let one branch's anchor for a parameter silently
   * overwrite the other's, and the frames it then chose were whichever the
   * catalog has more of. Here the records are split by the treatment the profile
   * will actually apply to them, and each branch is asked about its own.
   */
  const groups = TREATMENTS.map((treatment) => {
    const anchors = profile.branches[treatment]?.anchors ?? {};
    const records = available.filter((r) => resolveTreatment(profile, r, 'auto') === treatment);
    return { treatment, anchors, records, picks: Object.keys(anchors).length ? selectFrames(records, anchors) : [] };
  }).filter((g) => Object.keys(g.anchors).length > 0);

  // Naming a treatment is only useful when there is more than one to tell apart.
  const named = groups.filter((g) => g.picks.length > 0).length > 1;
  for (const group of groups) {
    if (group.picks.length === 0) {
      status(
        group.records.length === 0
          ? `no ${TREATMENT_LABEL[group.treatment]} photographs in this catalog — its controls keep their fitted gains`
          : `no ${TREATMENT_LABEL[group.treatment]} frame sits far enough outside the dead zone to judge — its controls keep their fitted gains`,
      );
    }
  }
  if (groups.every((g) => g.picks.length === 0)) return null;

  // Well above what fits on a stage, and deliberately: the loupe shows rendered
  // pixels at 1:1, so the headroom between this and the screen *is* the
  // magnification. Calibrating Dehaze or Clarity from a fit-to-window view means
  // judging haloing at the one scale that averages it away. The cost is paid
  // once — decode, two blurs, one upload per frame — and never again per slider.
  const size = options.size ?? 1800;
  const loaded: Loaded[] = [];
  const steps: PageStep[] = [];
  const picks = groups.flatMap((g) => g.picks.map((pick) => ({ pick, treatment: g.treatment })));
  for (const { pick, treatment } of picks) {
    if (!pick.family) continue; // the control frame has no slider of its own
    const family = FAMILIES.find((f) => f.id === pick.family);
    if (!family) continue;
    status(`decoding preview ${loaded.length + 1} of ${picks.length}`);
    let image: LinearImage;
    try {
      image = await decode(pick.record.file, size);
    } catch (e) {
      status(`skipped ${pick.record.file}: ${(e as Error).message}`);
      continue;
    }
    const sessionMean = contextFor(
      context,
      pick.record.file,
      baseFeatures(pick.record.embedding, pick.record.features, pick.record.asShot),
    );
    const ramp = buildRamp(profile, initial, { record: pick.record, sessionMean, family: family.id, treatment });

    // Where the slider starts and how far it travels, in the parameter's own
    // units. Whether the control is *worth offering* is decided in the browser
    // instead: it is a question about the rendered picture, and only the
    // renderer can answer it.
    const zero = ramp.samples[0]!.value;
    const fitted = ramp.samples[Math.round((ramp.samples.length - 1) / MAX_SCALE)]!.value;
    const far = ramp.samples[ramp.samples.length - 1]!.value;
    steps.push({
      id: loaded.length,
      // The key the reviewer's answer is stored under: this branch's anchors,
      // not the other's.
      family: intensityKey(treatment, family.id),
      label: family.label,
      treatment: named ? TREATMENT_LABEL[treatment]! : '',
      caption: `the ${named ? TREATMENT_LABEL[treatment] + ' ' : ''}photograph in your catalog this control changes the most`,
      unit: family.unit,
      decimals: family.decimals,
      width: image.width,
      height: image.height,
      zero: round(zero, family.decimals),
      fitted: round(fitted, family.decimals),
      min: round(Math.min(zero, far), family.decimals),
      max: round(Math.max(zero, far), family.decimals),
    });
    loaded.push({ image, ramp });
  }
  if (loaded.length === 0) return null;

  status(`${loaded.length} frame${loaded.length === 1 ? '' : 's'} ready — the browser renders them on the GPU`);

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
        res.end(page(steps));
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
      // What the browser made of the frames. Whether a control is reviewable is
      // decided by the render, and the render is over there — without this the
      // terminal would report five controls ready while the screen offers one,
      // and the photographer would have no way to find out which was true.
      if (url.pathname === '/diag' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        try {
          const diag = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            renderer?: string;
            selfTest?: string;
            canvas?: string;
            shot?: string;
            steps?: { label: string; change?: number; size?: string; dropped?: string }[];
          };
          status(`the browser is rendering on: ${diag.renderer ?? 'unknown'}`);
          if (diag.selfTest) status(`  draw self-test: ${diag.selfTest}`);
          if (diag.canvas) status(`  canvas ${diag.canvas}`);
          for (const s of diag.steps ?? []) {
            status(s.dropped ? `  ${s.label}: dropped — ${s.dropped}` : `  ${s.label}: ${s.size}, moves ${((s.change ?? 0) * 100).toFixed(1)}%`);
          }
          // A frame as the GPU drew it, on disk. Whether the shader is right is
          // not a question a log line can answer.
          const shot = /^data:image\/jpeg;base64,(.+)$/.exec(diag.shot ?? '');
          if (shot) {
            const file = path.join(tmpdir(), 'shoots-review-render.jpg');
            await writeFile(file, Buffer.from(shot[1]!, 'base64'));
            status(`  what it drew: ${file}`);
          }
        } catch {
          // A malformed report is not a reason to interrupt a review.
        }
        res.writeHead(204);
        res.end();
        return;
      }
      // The decoded frame, scene-linear and untouched. Sixteen-bit samples in
      // the machine's own byte order: the server and the browser are the same
      // machine — this listens on 127.0.0.1 and nothing else — so there is no
      // endianness to negotiate, and a conversion here would cost a copy of
      // every pixel to arrive at the bytes already in hand.
      const pixels = /^\/pixels\/(\d+)$/.exec(url.pathname);
      if (pixels) {
        const item = loaded[Number(pixels[1])];
        if (!item) {
          res.writeHead(404);
          res.end();
          return;
        }
        const { data } = item.image;
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'max-age=3600',
        });
        res.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        return;
      }
      const ramp = /^\/ramp\/(\d+)$/.exec(url.pathname);
      if (ramp) {
        const item = loaded[Number(ramp[1])];
        if (!item) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=3600' });
        res.end(JSON.stringify(item.ramp));
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
