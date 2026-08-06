/**
 * The RapidRAW adapter, against a real `.rrdata`.
 *
 * The fixture is an actual RapidRAW edit — every slider in the app moved once,
 * on a Canon CR3 — with the photographer's personal EXIF stripped. That matters:
 * a hand-written fixture would only ever contain the keys we already thought of,
 * and half the work here was discovering the ones we had not (two exposure
 * sliders, a curve that lives in `curves` while `pointCurves` holds a stale
 * copy, a `sectionVisibility` gate that silently zeroes whatever it hides).
 *
 * In-process rather than through the CLI, and deliberately free of exiftool: the
 * whole point of this adapter is that neither side of it needs one.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  canonicalCurve,
  canonicalTemperature,
  isEdited,
  kelvinToRr,
  mergeAdjustments,
  readPath,
  rrToKelvin,
  toCanonical,
  toRapidRaw,
  type RrAdjustments,
} from '../src/develop/adapters/rapidraw/map.js';
import {
  editedAdjustments,
  readSidecar,
  sidecarPathFor,
  type RrSidecar,
} from '../src/develop/adapters/rapidraw/ingest.js';
import { applyPrediction, loadOrCreate, writeSidecar } from '../src/develop/adapters/rapidraw/emit.js';
import { applyMarks } from '../src/develop/adapters/rapidraw/marks.js';
import { builtinLabelSet } from '../src/triage/labelSets.js';

const FIXTURE = path.resolve(import.meta.dir, 'fixtures/rapidraw-edited.rrdata');

async function loadFixture(): Promise<RrSidecar> {
  const sidecar = await readSidecar(FIXTURE);
  if (!sidecar) throw new Error(`fixture unreadable: ${FIXTURE}`);
  return sidecar;
}

/** A scratch copy of the fixture, so a test can write to it. */
async function scratch(): Promise<{ dir: string; file: string; dispose: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'shoots-rrdata-'));
  const file = path.join(dir, 'R-FD-28-5230.CR3.rrdata');
  await writeFile(file, await readFile(FIXTURE, 'utf8'), 'utf8');
  return { dir, file, dispose: () => rm(dir, { recursive: true, force: true }) };
}

describe('sidecar location', () => {
  test('keeps the extension, unlike the ACR convention', () => {
    const got = sidecarPathFor(path.join('/shoot', 'R-FD-28-5230.CR3'), '/shoot');
    expect(path.basename(got)).toBe('R-FD-28-5230.CR3.rrdata');
  });

  test('a CR3 and a JPEG of the same frame do not collide', () => {
    const raw = sidecarPathFor('/shoot/IMG_1.CR3', '/shoot');
    const jpeg = sidecarPathFor('/shoot/IMG_1.jpg', '/shoot');
    expect(raw).not.toBe(jpeg);
  });
});

describe('is this an edit at all', () => {
  test('the fixture is', async () => {
    expect(isEdited(editedAdjustments(await loadFixture()))).toBe(true);
  });

  test('adjustments: null is not — the ordinary state of an imported folder', () => {
    expect(isEdited(null)).toBe(false);
    expect(editedAdjustments({ version: 1, rating: 0, adjustments: null })).toBeNull();
  });

  test('the defaults RapidRAW writes on save are not an edit', () => {
    // Every non-zero default the app itself puts in a freshly saved sidecar.
    // Reading these as a decision is what teaches a model to predict "change
    // nothing" — the same trap the ACR adapter documents.
    const saved: RrAdjustments = {
      exposure: 0,
      contrast: 0,
      grainSize: 25,
      grainRoughness: 50,
      vignetteMidpoint: 50,
      vignetteFeather: 50,
      colorGrading: { blending: 50, balance: 0 },
      curves: {
        luma: [
          { x: 0, y: 0 },
          { x: 255, y: 255 },
        ],
      },
      // Lens corrections default to enabled at full strength; counting them
      // would mark every file in every catalog as edited.
      lensDistortionEnabled: true,
      lensDistortionAmount: 100,
      transformScale: 100,
    };
    expect(isEdited(saved)).toBe(false);
  });

  test('one moved slider is', () => {
    expect(isEdited({ contrast: 0, clarity: 4 })).toBe(true);
  });

  test('a bent curve is, even with every slider at rest', () => {
    expect(
      isEdited({
        curves: {
          luma: [
            { x: 0, y: 0 },
            { x: 128, y: 150 },
            { x: 255, y: 255 },
          ],
        },
      }),
    ).toBe(true);
  });
});

describe('white balance', () => {
  test('RapidRAW states it relative to the capture, so a shift needs an anchor', () => {
    // Same slider, two cameras: the absolute answer differs because the
    // starting point does. Defaulting the anchor would hide exactly this.
    expect(rrToKelvin(20, 5500)).toBeGreaterThan(rrToKelvin(20, 3200));
  });

  test('zero means as-shot, whatever as-shot was', () => {
    for (const asShot of [2800, 5500, 9000]) {
      expect(rrToKelvin(0, asShot)).toBeCloseTo(asShot, 6);
    }
  });

  test('round-trips through absolute Kelvin', () => {
    for (const slider of [-100, -37, 0, 12, 64, 100]) {
      expect(kelvinToRr(rrToKelvin(slider, 5500), 5500)).toBeCloseTo(slider, 6);
    }
  });

  test('positive is warmer', () => {
    expect(rrToKelvin(50, 5500)).toBeGreaterThan(5500);
    expect(rrToKelvin(-50, 5500)).toBeLessThan(5500);
  });

  test('stays inside the schema range even when the anchor is extreme', () => {
    // 10000 K as-shot is 100 mired; a +100 slider would take it past zero and
    // out the other side into negative Kelvin without the guard.
    for (const asShot of [2000, 10000, 25000]) {
      for (const slider of [-100, 100]) {
        const kelvin = rrToKelvin(slider, asShot);
        expect(kelvin).toBeGreaterThanOrEqual(2000);
        expect(kelvin).toBeLessThanOrEqual(50000);
      }
    }
  });

  test('is absent from the canonical map until the capture is known', async () => {
    const adjustments = editedAdjustments(await loadFixture())!;
    // The fixture moved the slider, so the omission is a decision, not a gap.
    expect(readPath(adjustments, 'temperature')).not.toBe(0);
    expect(toCanonical(adjustments)['Temperature']).toBeUndefined();
    expect(canonicalTemperature(adjustments, 5200)).toBeGreaterThan(5200);
  });
});

describe('the vocabulary crossing', () => {
  test('reads the fixture into canonical crs names', async () => {
    const develop = toCanonical(editedAdjustments(await loadFixture())!);

    // 1:1 sliders keep their value and change only their name.
    expect(develop['Exposure2012']).toBeCloseTo(1.22, 6);
    expect(develop['Contrast2012']).toBe(29);
    expect(develop['Highlights2012']).toBe(-27);
    expect(develop['Blacks2012']).toBe(12);
    expect(develop['Whites2012']).toBe(-15);
    expect(develop['Dehaze']).toBe(17);
    expect(develop['Vibrance']).toBe(15);
    expect(develop['Saturation']).toBe(-21);
    // RapidRAW calls ACR's Texture "structure".
    expect(develop['Texture']).toBe(11);
    expect(develop['Clarity2012']).toBe(10);

    // Geared sliders come back scaled.
    expect(develop['Shadows2012']).toBeCloseTo(20 / 1.5, 6);
    expect(develop['Tint']).toBeCloseTo(6 * 1.5, 6);
    expect(develop['HueAdjustmentRed']).toBeCloseTo(3 / 0.75, 6);
    expect(develop['SaturationAdjustmentRed']).toBe(-4);
    expect(develop['LuminanceAdjustmentRed']).toBe(9);

    // Nested groups.
    expect(develop['ColorGradeShadowHue']).toBe(323);
    expect(develop['ColorGradeMidtoneSat']).toBe(22);
    expect(develop['ColorGradeHighlightHue']).toBe(63);
    expect(develop['ColorGradeBlending']).toBe(53);
    expect(develop['SplitToningBalance']).toBe(-7);
    expect(develop['PostCropVignetteAmount']).toBe(-23);
    expect(develop['GrainAmount']).toBe(12);
  });

  test('never invents a black-and-white conversion', async () => {
    const develop = toCanonical(editedAdjustments(await loadFixture())!);
    expect(develop['ConvertToGrayscale']).toBeUndefined();
    expect(Object.keys(develop).some((k) => k.startsWith('GrayMixer'))).toBe(false);
  });

  test('lifts the curve out of `curves`, not the stale `pointCurves` copy', async () => {
    const adjustments = editedAdjustments(await loadFixture())!;
    // The fixture is the shape that would have caught a naive reader: the live
    // curve is bent, the stashed point-mode copy is still the identity line.
    expect(readPath(adjustments, 'pointCurves.luma.1.y')).toBe(255);
    const curve = canonicalCurve(adjustments);
    expect(curve).toBeDefined();
    expect(curve!.length).toBe(8); // four points, flattened
    expect(curve![2]).toBeCloseTo(62.142857, 4);
  });

  test('an identity curve reads as no curve at all', () => {
    expect(
      canonicalCurve({
        curves: {
          luma: [
            { x: 0, y: 0 },
            { x: 255, y: 255 },
          ],
        },
      }),
    ).toBeUndefined();
  });

  test('survives a round trip through the canonical vocabulary', async () => {
    const adjustments = editedAdjustments(await loadFixture())!;
    const develop = toCanonical(adjustments);
    develop['Temperature'] = canonicalTemperature(adjustments, 5500)!;
    const back = toRapidRaw(develop, canonicalCurve(adjustments), 5500);

    // Exact where the mapping is 1:1…
    for (const key of ['contrast', 'highlights', 'whites', 'blacks', 'dehaze', 'vibrance', 'saturation', 'structure']) {
      expect(readPath(back, key)).toBeCloseTo(readPath(adjustments, key)!, 6);
    }
    // …and to rounding where it is geared, including the white balance, which
    // has been to Kelvin and back.
    expect(readPath(back, 'shadows')).toBeCloseTo(readPath(adjustments, 'shadows')!, 4);
    expect(readPath(back, 'tint')).toBeCloseTo(readPath(adjustments, 'tint')!, 4);
    expect(readPath(back, 'temperature')).toBeCloseTo(readPath(adjustments, 'temperature')!, 4);
    expect(readPath(back, 'hsl.reds.hue')).toBeCloseTo(readPath(adjustments, 'hsl.reds.hue')!, 4);
    expect(readPath(back, 'colorGrading.shadows.hue')).toBe(323);
  });
});

describe('what an emitted patch must say out loud', () => {
  const patch = toRapidRaw({ Contrast2012: 20 }, [0, 0, 128, 150, 255, 255], 5500);

  test('pins every section it writes into visible', () => {
    // A hidden section is not a collapsed panel: the renderer substitutes zero
    // for everything inside it. Left alone, the prediction would land in the
    // file, read back correctly, and change nothing on screen.
    const visibility = patch['sectionVisibility'] as Record<string, boolean>;
    for (const section of ['basic', 'color', 'curves', 'details', 'effects']) {
      expect(visibility[section]).toBe(true);
    }
  });

  test('pins the curve mode, and mirrors the curve into the point-mode stash', () => {
    // `curves` is what renders; `pointCurves` is where the app keeps point-mode
    // state while the parametric editor has the floor. Writing only the first
    // would lose the prediction on a trip through the parametric tab.
    expect(patch['curveMode']).toBe('point');
    expect(readPath(patch, 'curves.luma.1.y')).toBe(150);
    expect(readPath(patch, 'pointCurves.luma.1.y')).toBe(150);
  });

  test('writes nothing for a parameter the model did not predict', () => {
    expect(readPath(patch, 'clarity')).toBeNull();
    expect(readPath(patch, 'temperature')).toBeNull();
  });

  test('falls back to legacy split toning only where the modern key is silent', () => {
    const modern = toRapidRaw({ ColorGradeShadowHue: 200, SplitToningShadowHue: 40 }, undefined, 5500);
    expect(readPath(modern, 'colorGrading.shadows.hue')).toBe(200);

    const legacy = toRapidRaw({ SplitToningShadowHue: 40 }, undefined, 5500);
    expect(readPath(legacy, 'colorGrading.shadows.hue')).toBe(40);
  });
});

describe('merging a prediction into a file that is not ours', () => {
  test('a patch replaces its own keys and leaves the neighbours alone', () => {
    const merged = mergeAdjustments(
      { hsl: { reds: { hue: 1, saturation: 2 }, blues: { hue: 3 } }, masks: [{ id: 'a' }] },
      { hsl: { reds: { saturation: 9 } } },
    );
    expect(readPath(merged, 'hsl.reds.saturation')).toBe(9);
    expect(readPath(merged, 'hsl.reds.hue')).toBe(1);
    expect(readPath(merged, 'hsl.blues.hue')).toBe(3);
    expect(merged['masks']).toEqual([{ id: 'a' }]);
  });

  test('a curve replaces wholesale rather than merging point by point', () => {
    // Arrays must not merge by index: a three-point curve overlaid on a
    // two-point one would keep the orphaned third point and bend differently.
    const merged = mergeAdjustments(
      { curves: { luma: [{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }] } },
      { curves: { luma: [{ x: 0, y: 0 }, { x: 255, y: 255 }] } },
    );
    const luma = (merged['curves'] as Record<string, unknown>)['luma'] as unknown[];
    expect(luma).toHaveLength(2);
  });

  test('the photographer keeps their masks, crop, lens work, rating and tags', async () => {
    const { file, dispose } = await scratch();
    try {
      const before = await loadOrCreate(file);
      const beforeAdjustments = before.adjustments as RrAdjustments;
      // Stand in for the parts of a real edit this tool does not predict.
      beforeAdjustments['masks'] = [{ id: 'mask-1', name: 'sky' }];
      beforeAdjustments['crop'] = { x: 10, y: 20, width: 300, height: 200 };
      await writeSidecar(file, before);

      const after = applyPrediction(await loadOrCreate(file), { Contrast2012: 40 }, undefined, 5500);
      await writeSidecar(file, after);

      const reread = (await readSidecar(file))!;
      const adjustments = reread.adjustments as RrAdjustments;
      expect(readPath(adjustments, 'contrast')).toBe(40);
      expect(adjustments['masks']).toEqual([{ id: 'mask-1', name: 'sky' }]);
      expect(adjustments['crop']).toEqual({ x: 10, y: 20, width: 300, height: 200 });
      // Untouched by the develop path, and the reason it is worth a test: this
      // is the same file the triage path writes into.
      expect(reread.rating).toBe(before.rating);
      expect(reread.tags).toEqual(['color:blue', 'user:portrait']);
      expect(reread.exif).toEqual(before.exif);
      // Lens corrections are not predicted and must come through verbatim.
      expect(readPath(adjustments, 'lensDistortionAmount')).toBe(100);
    } finally {
      await dispose();
    }
  });

  test('creates a sidecar RapidRAW would recognise when there is none', async () => {
    const { dir, dispose } = await scratch();
    try {
      const fresh = path.join(dir, 'NEW.CR3.rrdata');
      await writeSidecar(fresh, applyPrediction(await loadOrCreate(fresh), { Contrast2012: 5 }, undefined, 5500));
      const written = (await readSidecar(fresh))!;
      expect(written.version).toBe(1);
      expect(written.rating).toBe(0);
      expect(readPath(written.adjustments as RrAdjustments, 'contrast')).toBe(5);
    } finally {
      await dispose();
    }
  });
});

describe('triage marks', () => {
  const labels = builtinLabelSet('rapidraw');

  test('the label set is RapidRAW\'s own five, not Adobe\'s capitalised ones', () => {
    expect(labels.reject).toBe('red');
    expect(labels.select).toBe('green');
  });

  test('stars go to the native rating field', async () => {
    const { sidecar, written } = applyMarks(await loadFixture(), { stars: 4 }, labels);
    expect(sidecar.rating).toBe(4);
    expect(written['rating']).toBe(4);
  });

  test('a label replaces the existing colour rather than joining it', async () => {
    // The fixture already carries `color:blue`; two colour tags would make the
    // swatch depend on array order.
    const { sidecar } = applyMarks(await loadFixture(), { label: 'select' }, labels);
    expect(sidecar.tags).toContain('color:green');
    expect(sidecar.tags!.filter((t) => t.startsWith('color:'))).toHaveLength(1);
  });

  test('a reject with no label of its own still lands somewhere filterable', async () => {
    const { sidecar } = applyMarks(await loadFixture(), { reject: true }, labels);
    expect(sidecar.tags).toContain('color:red');
  });

  test('keywords are namespaced and lowercased, the way the app types them', async () => {
    const { sidecar } = applyMarks(await loadFixture(), { keywords: ['Portrait', 'Golden Hour'] }, labels);
    expect(sidecar.tags).toContain('user:golden hour');
    // Already present in the fixture as `user:portrait` — not duplicated.
    expect(sidecar.tags!.filter((t) => t === 'user:portrait')).toHaveLength(1);
  });

  test('marks never disturb the develop settings sharing the file', async () => {
    const before = await loadFixture();
    const { sidecar } = applyMarks(before, { stars: 5, label: 'review' }, labels);
    expect(sidecar.adjustments).toEqual(before.adjustments);
  });

  test('empty marks write nothing', async () => {
    const { written } = applyMarks(await loadFixture(), {}, labels);
    expect(Object.keys(written)).toHaveLength(0);
  });
});
