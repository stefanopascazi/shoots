/**
 * The review page, inline.
 *
 * No bundler, no framework, no CDN: the CLI ships as a single binary and every
 * runtime dependency has to be licence-checked, so a page that is a string in the
 * source costs nothing and can never drift from the server that serves it.
 *
 * Served by the CLI itself (`develop calibrate --review`), never by the app:
 * calibration is part of the free CLI and must work without the plug-in. Only
 * the look comes from the design system, as inlined CSS (`UI_CSS`).
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
import { UI_CSS } from '@shoots/ui';
import { CLIENT_SCRIPT } from './client.js';

export interface PageStep {
  /** Index into the server's loaded frames. */
  id: number;
  /** The control's key, `treatment:parameter` — e.g. `bw:Exposure2012`. */
  family: string;
  /** Human label, e.g. `Exposure`. */
  label: string;
  /**
   * Which treatment's anchors this control scales, named for the screen. Empty
   * when the profile has only one branch to review, where saying so is noise.
   */
  treatment: string;
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

export function page(steps: readonly PageStep[], run: string): string {
  if (steps.length === 0) return '<!doctype html><p>Nothing to calibrate.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Calibrate your profile</title>
<style>${UI_CSS}</style>
<style>
  /* Layout of this screen only; colours, type and controls come from @shoots/ui. */
  html, body { height:100%; }
  body { overflow:hidden; display:grid; grid-template-rows:auto minmax(0,1fr) auto; }
  header { padding:var(--sh-space-3) var(--sh-space-5); border-bottom:1px solid var(--sh-border);
           display:flex; align-items:baseline; gap:var(--sh-space-4); }
  header h1 { font-size:var(--sh-text-md); }
  header p { color:var(--sh-fg-muted); font-size:var(--sh-text-sm); }

  /* The middle row is the only thing allowed to take the leftover height, and
     minmax(0,1fr) is what lets it actually shrink instead of being sized by its
     content — which is how an image ends up pushing the page into a scrollbar. */
  main { display:grid; grid-template-columns:minmax(0,1fr) 300px; min-height:0; }
  @media (max-width:820px) { main { grid-template-columns:1fr; } }

  #boot { display:grid; place-items:center; padding:var(--sh-space-10); color:var(--sh-fg-muted);
          text-align:center; max-width:52ch; margin:0 auto; }
  /* An id beats [hidden]'s display:none on specificity, so without this the
     boot message never leaves — and it keeps a grid row, which is what made the
     stage measure a fraction of the height it actually had. */
  #boot[hidden] { display:none; }

  .stages { position:relative; min-height:0; padding:var(--sh-space-4); display:grid; place-items:center; overflow:hidden; }
  .stage { width:100%; height:100%; min-height:0; display:grid; place-items:center; }
  .stage[hidden] { display:none; }
  /* Contained, never enlarged — but sized by the renderer in JavaScript, not
     here: max-height:100% resolves against a grid item with height:auto, which
     is indefinite, so the browser drops the constraint and a portrait frame
     keeps its full height. See fitCanvas(). The design system's max-width on
     canvas is lifted for the same reason. */
  #gl { max-width:none; border-radius:var(--sh-radius-md); box-shadow:var(--sh-shadow-lg); cursor:crosshair; }
  .stage img { width:auto; height:auto; max-height:100%; border-radius:var(--sh-radius-md); box-shadow:var(--sh-shadow-lg); }

  /* The loupe: rendered pixels at 1:1, parked in a corner so it never covers
     what is being examined. The box on the image marks what it is showing. */
  .loupe { position:absolute; top:20px; right:20px; display:none; border-radius:var(--sh-radius-md);
           overflow:hidden; border:1px solid var(--sh-border); background:var(--sh-surface);
           box-shadow:var(--sh-shadow-lg); pointer-events:none; }
  .loupe canvas { max-width:none; }
  .loupe span { position:absolute; left:0; bottom:0; padding:2px 7px; font-size:var(--sh-text-xs);
                font-variant-numeric:tabular-nums; color:#fff; background:rgb(0 0 0 / .55);
                border-top-right-radius:var(--sh-radius-sm); }
  .loupe-box { position:fixed; display:none; pointer-events:none; z-index:5;
               border:1px solid rgb(255 255 255 / .9); box-shadow:0 0 0 1px rgb(0 0 0 / .55); }

  aside { border-left:1px solid var(--sh-border); background:var(--sh-surface); padding:var(--sh-space-5);
          overflow-y:auto; display:flex; flex-direction:column; }
  @media (max-width:820px) { aside { border-left:0; border-top:1px solid var(--sh-border); } }
  #panels { display:contents; }
  .control[hidden] { display:none; }
  .control h2 { margin-bottom:2px; font-size:var(--sh-text-xl); }
  .treatment { margin-bottom:var(--sh-space-1); }
  .why { margin-bottom:var(--sh-space-5); color:var(--sh-fg-muted); font-size:var(--sh-text-sm); }
  .control output { display:block; margin-bottom:var(--sh-space-3); font:600 var(--sh-text-3xl)/1 var(--sh-font-mono);
                    font-variant-numeric:tabular-nums; }
  .hint { margin-top:var(--sh-space-3); color:var(--sh-fg-muted); font-size:var(--sh-text-xs); }
  .hint b { color:var(--sh-fg); font-weight:600; }
  /* Shown on a control whose frame barely moves: offered anyway, but honest
     about it, rather than quietly missing from the screen. */
  .inert { margin-top:var(--sh-space-3); padding:var(--sh-space-3); border-radius:var(--sh-radius-md);
           background:var(--sh-warning-soft); font-size:var(--sh-text-xs); }
  .control .reset { margin-top:var(--sh-space-4); }
  .save { margin-top:auto; padding-top:var(--sh-space-5); }
  #status { color:var(--sh-fg-muted); font-size:var(--sh-text-xs); margin-top:var(--sh-space-2); min-height:1.3em; }

  /* The film strip: every control's photograph, always reachable. */
  footer { border-top:1px solid var(--sh-border); padding:var(--sh-space-2) var(--sh-space-3); display:flex;
           gap:var(--sh-space-2); overflow-x:auto; align-items:flex-end; }
  footer[hidden] { display:none; }
  .thumb { padding:4px; display:grid; gap:4px; justify-items:center; flex:0 0 auto; cursor:pointer;
           border:0; border-radius:var(--sh-radius-sm); background:none; }
  .thumb img { width:82px; height:56px; object-fit:cover; border-radius:var(--sh-radius-sm); opacity:.55;
               transition:opacity var(--sh-fast) var(--sh-ease); }
  .thumb span { font-size:var(--sh-text-xs); color:var(--sh-fg-muted); max-width:88px; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; }
  .thumb:hover img { opacity:.85; }
  .thumb.current img { opacity:1; outline:2px solid var(--sh-accent); outline-offset:1px; }
  .thumb.current span { color:var(--sh-fg); }
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
      <button id="save" class="sh-btn sh-btn--primary sh-btn--block">Save into the profile</button>
      <div id="status"></div>
    </div>
  </aside>
</main>
<footer hidden></footer>
<script>
window.__REVIEW__ = ${JSON.stringify({ steps, threshold: REVIEWABLE_THRESHOLD })};
// Stamped fresh on every run and echoed back in the report. If the server sees
// a different one it knows the browser is executing a page it kept from an
// earlier review, which otherwise looks exactly like a bug in the renderer.
window.__REVIEW__.run = ${JSON.stringify(run)};
</script>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}
