/**
 * The review page, inline.
 *
 * No bundler, no framework, no CDN: the CLI ships as a single binary and every
 * runtime dependency has to be licence-checked, so a page that is a string in the
 * source costs nothing and can never drift from the server that serves it.
 *
 * **One photograph, one control, one step at a time.** The first version put five
 * frames and four sliders on screen together and it read as though every slider
 * applied to every frame — which is true of the profile and useless as an
 * explanation, because each frame was chosen to demonstrate exactly one control.
 * Judging "how much highlight recovery" against a photograph picked for its
 * exposure is asking a question about the wrong picture.
 *
 * And the slider reads in the parameter's own units, not as a multiplier on a
 * fitted gain. "×2.2" says nothing about what will land in Lightroom; "−1.4 EV"
 * is the thing being decided. The multiplier is computed back from wherever the
 * slider is left.
 */

export interface PageStep {
  /** Index into the server's loaded frames. */
  id: number;
  /** Family id, e.g. `exposure`. */
  family: string;
  /** Family label, e.g. `Exposure`. */
  label: string;
  caption: string;
  unit: string;
  decimals: number;
  /** The parameter's value on this frame with the correction switched off. */
  zero: number;
  /** Its value at the gain exactly as fitted — where the slider starts. */
  fitted: number;
  /** Slider bounds, already clamped to what the parameter allows. */
  min: number;
  max: number;
}

export function page(steps: readonly PageStep[]): string {
  if (steps.length === 0) return '<!doctype html><p>Nothing to calibrate.</p>';

  const panels = steps
    .map(
      (s, i) => `
    <section class="step" data-index="${i}" data-family="${s.family}" ${i === 0 ? '' : 'hidden'}>
      <div class="frame"><img id="img-${s.id}" src="/frame/${s.id}" alt="${s.label}"></div>
      <div class="control">
        <h2>${s.label}</h2>
        <p class="why">${s.caption}</p>
        <input type="range" id="r-${i}" min="${s.min}" max="${s.max}" step="${s.decimals > 0 ? 0.01 : 1}" value="${s.fitted}">
        <div class="readout">
          <output id="v-${i}">${s.fitted.toFixed(s.decimals)}${s.unit}</output>
          <span class="hint">fitted <b>${s.fitted.toFixed(s.decimals)}${s.unit}</b> · off <b>${s.zero.toFixed(s.decimals)}${s.unit}</b></span>
        </div>
        <div class="actions">
          <button class="ghost" data-back ${i === 0 ? 'disabled' : ''}>Back</button>
          <button class="ghost" data-reset>Reset</button>
          <button class="primary" data-next>${i === steps.length - 1 ? 'Save into the profile' : 'Next'}</button>
        </div>
        <div class="progress">${i + 1} of ${steps.length}</div>
      </div>
    </section>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Calibrate your profile</title>
<style>
  :root { color-scheme: light dark; --bg:#111; --fg:#eee; --panel:#1c1c1c; --line:#333; --accent:#5b9dd9; --muted:#999; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f6f6; --fg:#1a1a1a; --panel:#fff; --line:#ddd; --muted:#666; } }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.55 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:16px 24px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 3px; font-size:16px; font-weight:600; }
  header p { margin:0; color:var(--muted); max-width:78ch; font-size:13px; }
  .step { display:grid; grid-template-columns: 1fr 340px; gap:24px; padding:22px 24px; align-items:start; }
  @media (max-width:900px) { .step { grid-template-columns:1fr; } }
  .frame { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; }
  img { display:block; width:100%; height:auto; border-radius:6px; background:#000; }
  .control h2 { margin:0 0 4px; font-size:20px; }
  .why { margin:0 0 20px; color:var(--muted); font-size:13px; }
  input[type=range] { width:100%; accent-color:var(--accent); }
  .readout { display:flex; justify-content:space-between; align-items:baseline; gap:10px; margin-top:8px; }
  output { font:600 24px/1 ui-monospace,SFMono-Regular,Consolas,monospace; font-variant-numeric:tabular-nums; }
  .hint { color:var(--muted); font-size:12px; text-align:right; }
  .actions { margin-top:26px; display:flex; gap:8px; }
  button { font:inherit; padding:9px 16px; border-radius:6px; border:1px solid var(--line); background:var(--panel); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; margin-left:auto; }
  button:disabled { opacity:.4; cursor:default; }
  .progress { margin-top:14px; color:var(--muted); font-size:12px; }
  #status { padding:0 24px 22px; color:var(--muted); }
</style></head><body>
<header>
  <h1>Calibrate your profile</h1>
  <p>One control at a time, on the photograph in your catalog where it does the most.
     The number is what the profile will put in that slider — move it until the picture
     looks right. Clarity and Texture are not calibrated here: they are local-contrast
     effects this preview cannot reproduce.</p>
</header>
${panels}
<div id="status"></div>
<script>
  const steps = ${JSON.stringify(steps.map((s) => ({ id: s.id, family: s.family, zero: s.zero, fitted: s.fitted, unit: s.unit, decimals: s.decimals })))};
  const status = document.getElementById('status');
  let at = 0;
  const chosen = {};
  for (const s of steps) chosen[s.family] = 1;

  // Slider value to multiplier. The fitted gain puts the parameter at s.fitted
  // and switching it off puts it at s.zero, so the response is linear between
  // them and any value on the slider maps straight back onto a gain scale.
  function scaleFor(s, value) {
    const span = s.fitted - s.zero;
    return Math.abs(span) < 1e-9 ? 1 : (value - s.zero) / span;
  }
  function query(overrideFamily, overrideScale) {
    const p = new URLSearchParams();
    for (const s of steps) {
      p.set(s.family, String(s.family === overrideFamily ? overrideScale : chosen[s.family]));
    }
    return p.toString();
  }

  let inflight = false, queued = null;
  async function repaint(index) {
    const s = steps[index];
    const value = parseFloat(document.getElementById('r-' + index).value);
    const scale = scaleFor(s, value);
    chosen[s.family] = scale;
    if (inflight) { queued = index; return; }
    inflight = true;
    await new Promise((res) => {
      const img = document.getElementById('img-' + s.id);
      const next = new Image();
      next.onload = next.onerror = () => { img.src = next.src; res(); };
      next.src = '/frame/' + s.id + '?' + query();
    });
    inflight = false;
    if (queued !== null) { const q = queued; queued = null; repaint(q); }
  }

  function show(index) {
    at = index;
    for (const el of document.querySelectorAll('.step')) el.hidden = Number(el.dataset.index) !== index;
    repaint(index);
  }

  steps.forEach((s, i) => {
    const range = document.getElementById('r-' + i), out = document.getElementById('v-' + i);
    range.addEventListener('input', () => {
      out.textContent = parseFloat(range.value).toFixed(s.decimals) + s.unit;
      repaint(i);
    });
    const panel = document.querySelector('.step[data-index="' + i + '"]');
    panel.querySelector('[data-back]').addEventListener('click', () => show(i - 1));
    panel.querySelector('[data-reset]').addEventListener('click', () => {
      range.value = s.fitted;
      out.textContent = s.fitted.toFixed(s.decimals) + s.unit;
      repaint(i);
    });
    panel.querySelector('[data-next]').addEventListener('click', async () => {
      if (i < steps.length - 1) { show(i + 1); return; }
      status.textContent = 'Saving…';
      const r = await fetch('/save', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chosen),
      });
      status.textContent = r.ok
        ? 'Saved — you can close this tab.'
        : 'Save failed.';
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' && at < steps.length - 1) show(at + 1);
    if (e.key === 'ArrowLeft' && at > 0) show(at - 1);
  });
</script>
</body></html>`;
}
