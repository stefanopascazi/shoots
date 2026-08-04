/**
 * The review page, inline.
 *
 * No bundler, no framework, no CDN: the CLI ships as a single binary and every
 * runtime dependency has to be licence-checked, so a page that is a string in the
 * source costs nothing and can never drift from the server that serves it.
 *
 * **One photograph, one control, and the whole photograph on screen.** Three
 * things this gets right that the first two attempts did not:
 *
 * - The page never scrolls. It is a viewport-height grid — header, stage, film
 *   strip — and the image is contained inside the stage rather than sizing it.
 *   Scrolling to see the bottom of a photograph you are judging the exposure of
 *   is absurd.
 * - The image is **never upscaled**. The preview is rendered at a known pixel
 *   size and that size is the ceiling, so a small frame sits small and sharp
 *   instead of being stretched into mush.
 * - There is a film strip. Each control has its own photograph and you can move
 *   between them at will — click, arrow keys — rather than being marched through
 *   a queue.
 *
 * The slider reads in the parameter's own units, not as a multiplier on a fitted
 * gain: "×2.2" says nothing about what will land in Lightroom, "−1.4 EV" is the
 * thing being decided. The multiplier is computed back from where it is left.
 */

export interface PageStep {
  /** Index into the server's loaded frames. */
  id: number;
  /** Anchored parameter this control scales, e.g. `Exposure2012`. */
  family: string;
  /** Human label, e.g. `Exposure`. */
  label: string;
  caption: string;
  unit: string;
  decimals: number;
  /** The parameter's value on this frame with the correction switched off. */
  zero: number;
  /** Its value at the gain exactly as fitted — where the slider starts. */
  fitted: number;
  min: number;
  max: number;
  /** Rendered preview size, so the image is never scaled beyond it. */
  width: number;
  height: number;
}

export function page(steps: readonly PageStep[]): string {
  if (steps.length === 0) return '<!doctype html><p>Nothing to calibrate.</p>';

  const stages = steps
    .map(
      (s, i) => `
      <figure class="stage" data-index="${i}" ${i === 0 ? '' : 'hidden'}>
        <img id="img-${s.id}" src="/frame/${s.id}" alt="${s.label}"
             style="max-width:${s.width}px;max-height:${s.height}px">
      </figure>`,
    )
    .join('');

  const panels = steps
    .map(
      (s, i) => `
      <div class="control" data-index="${i}" ${i === 0 ? '' : 'hidden'}>
        <h2>${s.label}</h2>
        <p class="why">${s.caption}</p>
        <output id="v-${i}">${s.fitted.toFixed(s.decimals)}${s.unit}</output>
        <input type="range" id="r-${i}" min="${s.min}" max="${s.max}"
               step="${s.decimals > 0 ? 0.01 : 1}" value="${s.fitted}">
        <div class="ends"><span>${s.min.toFixed(s.decimals)}</span><span>${s.max.toFixed(s.decimals)}</span></div>
        <p class="hint">fitted <b>${s.fitted.toFixed(s.decimals)}${s.unit}</b> · off <b>${s.zero.toFixed(s.decimals)}${s.unit}</b></p>
        <button class="ghost" data-reset>Reset to fitted</button>
      </div>`,
    )
    .join('');

  const thumbs = steps
    .map(
      (s, i) => `
      <button class="thumb${i === 0 ? ' current' : ''}" data-go="${i}" title="${s.label}">
        <img src="/thumb/${s.id}" alt="">
        <span>${s.label}</span>
      </button>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Calibrate your profile</title>
<style>
  :root {
    color-scheme: light dark;
    --bg:#0e0e0f; --fg:#ededed; --panel:#191a1b; --line:#2c2d2f; --accent:#5b9dd9; --muted:#8b8d90;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f2f3f4; --fg:#17181a; --panel:#fff; --line:#dcdee0; --muted:#6b6d70; }
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body {
    margin:0; overflow:hidden;
    font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
    background:var(--bg); color:var(--fg);
    display:grid; grid-template-rows:auto minmax(0,1fr) auto;
  }
  header { padding:12px 20px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:14px; }
  header h1 { margin:0; font-size:15px; font-weight:600; }
  header p { margin:0; color:var(--muted); font-size:12.5px; }

  /* The middle row is the only thing allowed to take the leftover height, and
     minmax(0,1fr) is what lets it actually shrink instead of being sized by its
     content — which is how an image ends up pushing the page into a scrollbar. */
  main { display:grid; grid-template-columns:minmax(0,1fr) 300px; min-height:0; }
  @media (max-width:820px) { main { grid-template-columns:1fr; } }

  .stages { position:relative; min-height:0; padding:16px; display:grid; place-items:center; }
  .stage { margin:0; min-height:0; max-height:100%; display:grid; place-items:center; }
  .stage[hidden] { display:none; }
  /* Contained, never enlarged: the inline max-width/max-height carry the render's
     own pixel size, so a small preview stays small and crisp. */
  img { display:block; width:auto; height:auto; max-width:100%; max-height:100%;
        border-radius:6px; box-shadow:0 2px 18px rgb(0 0 0 / .35); }

  aside { border-left:1px solid var(--line); padding:20px; overflow-y:auto; display:flex; flex-direction:column; }
  @media (max-width:820px) { aside { border-left:0; border-top:1px solid var(--line); } }
  .control[hidden] { display:none; }
  .control h2 { margin:0 0 2px; font-size:19px; }
  .why { margin:0 0 18px; color:var(--muted); font-size:12.5px; }
  output { display:block; font:600 30px/1 ui-monospace,SFMono-Regular,Consolas,monospace;
           font-variant-numeric:tabular-nums; margin-bottom:10px; }
  input[type=range] { width:100%; accent-color:var(--accent); }
  .ends { display:flex; justify-content:space-between; color:var(--muted); font-size:11px;
          font-variant-numeric:tabular-nums; margin-top:2px; }
  .hint { color:var(--muted); font-size:12px; margin:14px 0 0; }
  button { font:inherit; padding:8px 14px; border-radius:6px; border:1px solid var(--line);
           background:var(--panel); color:var(--fg); cursor:pointer; }
  button.ghost { margin-top:16px; align-self:flex-start; }
  .save { margin-top:auto; padding-top:18px; }
  .save button { width:100%; background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  #status { color:var(--muted); font-size:12px; margin-top:10px; min-height:1.3em; }

  /* The film strip: every control's photograph, always reachable. */
  footer { border-top:1px solid var(--line); padding:10px 14px; display:flex; gap:10px;
           overflow-x:auto; align-items:flex-end; }
  .thumb { padding:4px; display:grid; gap:4px; justify-items:center; border-color:transparent;
           background:none; flex:0 0 auto; }
  .thumb img { width:82px; height:56px; object-fit:cover; border-radius:4px; opacity:.55;
               box-shadow:none; transition:opacity .12s; }
  .thumb span { font-size:11px; color:var(--muted); max-width:88px; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; }
  .thumb:hover img { opacity:.85; }
  .thumb.current img { opacity:1; outline:2px solid var(--accent); outline-offset:1px; }
  .thumb.current span { color:var(--fg); }
</style></head><body>
<header>
  <h1>Calibrate your profile</h1>
  <p>Each control, on the photograph in your catalog where it does the most. The number is what
     the profile will put in that slider. Clarity and Texture are not here — local contrast is
     something this preview cannot show.</p>
</header>
<main>
  <div class="stages">${stages}</div>
  <aside>
    ${panels}
    <div class="save">
      <button id="save">Save into the profile</button>
      <div id="status"></div>
    </div>
  </aside>
</main>
<footer>${thumbs}</footer>
<script>
  const steps = ${JSON.stringify(
    steps.map((s) => ({ id: s.id, family: s.family, zero: s.zero, fitted: s.fitted, unit: s.unit, decimals: s.decimals })),
  )};
  const status = document.getElementById('status');
  const chosen = {};
  for (const s of steps) chosen[s.family] = 1;
  let at = 0;

  // Slider value to multiplier. The fitted gain puts the parameter at s.fitted
  // and switching it off puts it at s.zero, so the response is linear between
  // them and any value maps straight back onto a gain scale.
  function scaleFor(s, value) {
    const span = s.fitted - s.zero;
    return Math.abs(span) < 1e-9 ? 1 : (value - s.zero) / span;
  }
  function query() {
    const p = new URLSearchParams();
    for (const s of steps) p.set(s.family, String(chosen[s.family]));
    return p.toString();
  }

  let inflight = false, queued = null;
  async function repaint(index) {
    const s = steps[index];
    chosen[s.family] = scaleFor(s, parseFloat(document.getElementById('r-' + index).value));
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
    for (const el of document.querySelectorAll('.stage, .control')) {
      el.hidden = Number(el.dataset.index) !== index;
    }
    for (const t of document.querySelectorAll('.thumb')) {
      t.classList.toggle('current', Number(t.dataset.go) === index);
    }
  }

  steps.forEach((s, i) => {
    const range = document.getElementById('r-' + i), out = document.getElementById('v-' + i);
    range.addEventListener('input', () => {
      out.textContent = parseFloat(range.value).toFixed(s.decimals) + s.unit;
      repaint(i);
    });
    document.querySelector('.control[data-index="' + i + '"] [data-reset]')
      .addEventListener('click', () => {
        range.value = s.fitted;
        out.textContent = s.fitted.toFixed(s.decimals) + s.unit;
        repaint(i);
      });
  });
  for (const t of document.querySelectorAll('.thumb')) {
    t.addEventListener('click', () => show(Number(t.dataset.go)));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') show(Math.min(steps.length - 1, at + 1));
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') show(Math.max(0, at - 1));
  });
  document.getElementById('save').addEventListener('click', async () => {
    status.textContent = 'Saving…';
    const r = await fetch('/save', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chosen),
    });
    status.textContent = r.ok ? 'Saved — you can close this tab.' : 'Save failed.';
  });
</script>
</body></html>`;
}
