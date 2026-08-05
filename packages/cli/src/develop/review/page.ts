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
 *
 * The body of the screen is built by `client.ts` once the frames are on the GPU,
 * because which controls are worth offering is a question about the rendered
 * picture and only the renderer can answer it.
 */
import { CLIENT_SCRIPT } from './client.js';

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
  /** Decoded preview size, so the image is never scaled beyond it. */
  width: number;
  height: number;
}

/** Below this 95th-percentile pixel change, a control is not offered at all. */
export const REVIEWABLE_THRESHOLD = 0.02;

export function page(steps: readonly PageStep[]): string {
  if (steps.length === 0) return '<!doctype html><p>Nothing to calibrate.</p>';

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

  #boot { display:grid; place-items:center; padding:40px; color:var(--muted); text-align:center; max-width:52ch; margin:0 auto; }
  /* An id beats [hidden]'s display:none on specificity, so without this the
     boot message never leaves — and it keeps a grid row, which is what made the
     stage measure a fraction of the height it actually had. */
  #boot[hidden] { display:none; }

  .stages { position:relative; min-height:0; padding:16px; display:grid; place-items:center; overflow:hidden; }
  .stage { margin:0; width:100%; height:100%; min-height:0; display:grid; place-items:center; }
  .stage[hidden] { display:none; }
  /* Contained, never enlarged — but sized by the renderer in JavaScript, not
     here: max-height:100% resolves against a grid item with height:auto, which
     is indefinite, so the browser drops the constraint and a portrait frame
     keeps its full height. See fitCanvas(). */
  #gl { display:block; border-radius:6px;
        box-shadow:0 2px 18px rgb(0 0 0 / .35); cursor:crosshair; }
  img { display:block; width:auto; height:auto; max-width:100%; max-height:100%;
        border-radius:6px; box-shadow:0 2px 18px rgb(0 0 0 / .35); }

  /* The loupe: rendered pixels at 1:1, parked in a corner so it never covers
     what is being examined. The box on the image marks what it is showing. */
  .loupe { position:absolute; top:20px; right:20px; display:none; border-radius:6px;
           overflow:hidden; border:1px solid var(--line); background:var(--panel);
           box-shadow:0 4px 24px rgb(0 0 0 / .5); pointer-events:none; }
  .loupe canvas { display:block; }
  .loupe span { position:absolute; left:0; bottom:0; padding:2px 7px; font-size:11px;
                font-variant-numeric:tabular-nums; color:#fff; background:rgb(0 0 0 / .55);
                border-top-right-radius:5px; }
  .loupe-box { position:fixed; display:none; pointer-events:none; z-index:5;
               border:1px solid rgb(255 255 255 / .9); box-shadow:0 0 0 1px rgb(0 0 0 / .55); }

  aside { border-left:1px solid var(--line); padding:20px; overflow-y:auto; display:flex; flex-direction:column; }
  @media (max-width:820px) { aside { border-left:0; border-top:1px solid var(--line); } }
  #panels { display:contents; }
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
  footer[hidden] { display:none; }
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
     the profile will put in that slider.</p>
</header>
<div id="boot">Starting the renderer…</div>
<main id="main" hidden>
  <div class="stages"></div>
  <aside>
    <div id="panels"></div>
    <div class="save">
      <button id="save">Save into the profile</button>
      <div id="status"></div>
    </div>
  </aside>
</main>
<footer hidden></footer>
<script>
window.__REVIEW__ = ${JSON.stringify({ steps, threshold: REVIEWABLE_THRESHOLD })};
</script>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}
