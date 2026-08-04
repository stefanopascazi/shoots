/**
 * The review page, inline.
 *
 * No bundler, no framework, no CDN: the CLI ships as a single binary and every
 * runtime dependency has to be licence-checked, so a page that is a string in the
 * source costs nothing and can never drift from the server that serves it.
 */
import { FAMILIES } from './select.js';

export interface PageFrame {
  id: number;
  label: string;
  family?: string;
  caption: string;
}

export function page(frames: readonly PageFrame[], initial: Record<string, number>): string {
  const sliders = FAMILIES.filter((f) => initial[f.id] !== undefined)
    .map(
      (f) => `
      <label class="slider">
        <span class="name">${f.label}</span>
        <input type="range" id="s-${f.id}" min="0" max="3" step="0.05" value="${initial[f.id]}">
        <output id="o-${f.id}">${Number(initial[f.id]).toFixed(2)}×</output>
      </label>`,
    )
    .join('');

  const tiles = frames
    .map(
      (f) => `
      <figure>
        <img id="img-${f.id}" src="/frame/${f.id}" alt="${f.label}">
        <figcaption><strong>${f.label}</strong><br>${f.caption}</figcaption>
      </figure>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Calibrate your profile</title>
<style>
  :root { color-scheme: light dark; --bg:#111; --fg:#eee; --panel:#1c1c1c; --line:#333; --accent:#5b9dd9; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f6f6; --fg:#1a1a1a; --panel:#fff; --line:#ddd; } }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:18px 24px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:17px; font-weight:600; }
  header p { margin:0; opacity:.7; max-width:70ch; }
  main { display:grid; grid-template-columns: 320px 1fr; gap:0; align-items:start; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  aside { padding:20px 24px; position:sticky; top:0; }
  .slider { display:block; margin-bottom:18px; }
  .slider .name { display:block; font-weight:600; margin-bottom:6px; }
  .slider input { width:100%; accent-color: var(--accent); }
  .slider output { font-variant-numeric: tabular-nums; opacity:.75; }
  .gallery { display:flex; flex-wrap:wrap; gap:14px; padding:20px 24px; }
  figure { margin:0; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px; max-width:340px; }
  img { display:block; width:100%; height:auto; border-radius:4px; background:#000; }
  figcaption { font-size:12px; opacity:.75; margin-top:8px; }
  .actions { margin-top:26px; display:flex; gap:10px; flex-wrap:wrap; }
  button { font:inherit; padding:9px 16px; border-radius:6px; border:1px solid var(--line); background:var(--panel); color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  #status { margin-top:14px; min-height:1.4em; opacity:.7; font-size:13px; }
</style></head><body>
<header>
  <h1>Calibrate your profile</h1>
  <p>These frames were picked because they are the ones each control actually changes — the
     last one sits in the middle and should barely move. Set each slider where the correction
     looks right to you, then save. Clarity and Texture are not shown: they are local-contrast
     effects this preview cannot reproduce.</p>
</header>
<main>
  <aside>
    ${sliders}
    <div class="actions">
      <button class="primary" id="save">Save into the profile</button>
      <button id="reset">Reset to fitted</button>
    </div>
    <div id="status"></div>
  </aside>
  <div class="gallery">${tiles}</div>
</main>
<script>
  const ids = ${JSON.stringify(FAMILIES.filter((f) => initial[f.id] !== undefined).map((f) => f.id))};
  const frames = ${JSON.stringify(frames.map((f) => f.id))};
  const fitted = ${JSON.stringify(initial)};
  const status = document.getElementById('status');
  let pending = null, inflight = false;

  function values() {
    const v = {};
    for (const id of ids) v[id] = parseFloat(document.getElementById('s-' + id).value);
    return v;
  }
  async function apply() {
    if (inflight) { pending = true; return; }
    inflight = true;
    const q = new URLSearchParams(Object.entries(values()).map(([k, v]) => [k, String(v)])).toString();
    await Promise.all(frames.map((id) => new Promise((res) => {
      const img = document.getElementById('img-' + id);
      const next = new Image();
      next.onload = next.onerror = () => { img.src = next.src; res(); };
      next.src = '/frame/' + id + '?' + q;
    })));
    inflight = false;
    if (pending) { pending = false; apply(); }
  }
  for (const id of ids) {
    const s = document.getElementById('s-' + id), o = document.getElementById('o-' + id);
    s.addEventListener('input', () => { o.textContent = parseFloat(s.value).toFixed(2) + '×'; apply(); });
  }
  document.getElementById('reset').addEventListener('click', () => {
    for (const id of ids) {
      const s = document.getElementById('s-' + id);
      s.value = fitted[id];
      document.getElementById('o-' + id).textContent = Number(fitted[id]).toFixed(2) + '×';
    }
    apply();
  });
  document.getElementById('save').addEventListener('click', async () => {
    status.textContent = 'Saving…';
    const r = await fetch('/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values()) });
    status.textContent = r.ok ? 'Saved. You can close this tab — the profile is being written.' : 'Save failed.';
  });
</script>
</body></html>`;
}
