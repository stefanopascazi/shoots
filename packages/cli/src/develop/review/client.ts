/**
 * The browser half of the review screen.
 *
 * Shipped as a string for the same reason the page is: the CLI is a single
 * binary with no bundler and every runtime dependency has to be licence-checked,
 * so a client that is source in this repository can never drift from the server
 * that serves it.
 *
 * The division of labour is the point. **Prediction stays on the server** —
 * scaling an anchor and re-running the model is the profile's own logic and has
 * no business being reimplemented in JavaScript — while **rendering happens
 * here**, on the GPU, because that is where a slider can move at the speed of a
 * hand. The server hands over a ramp of predictions once per control; after that
 * a drag costs one draw call and no round trip.
 *
 * Written in ES2020 without template literals: this whole file is interpolated
 * into one, and a nested backtick would be a debugging session nobody needs.
 */
import { FRAGMENT_SHADER, QUAD, VERTEX_SHADER } from './glsl.js';

/** Uniforms the shader takes, in the order they are set. */
const SLIDER_UNIFORMS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'clarity',
  'texture',
  'dehaze',
  'vibrance',
  'saturation',
] as const;

export type SliderUniform = (typeof SLIDER_UNIFORMS)[number];

/** One point on a control's ramp: what the model predicts at that intensity. */
export interface RampSample {
  /** Multiplier applied to the family's fitted gain. */
  scale: number;
  /** The value the reviewed parameter lands on, in its own units. */
  value: number;
  /** Per-channel white balance gain, already colorimetric. */
  wb: [number, number, number];
  u: Record<SliderUniform, number>;
}

export interface Ramp {
  /** The eight black-and-white mix sliders, −1..1, or null for a colour frame. */
  mono: number[] | null;
  /** Point-curve knots as `[x, y]` at 0..255, or `[]` for the identity. */
  curve: [number, number][];
  /** Parametric curve: highlights, lights, darks, shadows, each −1..1. */
  parametric: [number, number, number, number];
  samples: RampSample[];
}

const uniformNames = SLIDER_UNIFORMS.map((n) => 'u' + n[0]!.toUpperCase() + n.slice(1)).join("','");

export const CLIENT_SCRIPT = `
'use strict';
var VERT = ${JSON.stringify(VERTEX_SHADER)};
var FRAG = ${JSON.stringify(FRAGMENT_SHADER)};
var QUAD = ${JSON.stringify(QUAD)};
var SLIDERS = ['${SLIDER_UNIFORMS.join("','")}'];
var UNIFORMS = ['${uniformNames}'];

var DATA = window.__REVIEW__;
var statusEl = document.getElementById('status');
var stagesEl = document.querySelector('.stages');
var asideEl = document.getElementById('panels');
var stripEl = document.querySelector('footer');
var bootEl = document.getElementById('boot');

var G = null;      // WebGL context and program
var frames = [];   // one per surviving control
var at = 0;
var chosen = {};

/* ── WebGL ──────────────────────────────────────────────────────────────── */

function compile(gl, type, src) {
  var s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error('shader: ' + gl.getShaderInfoLog(s));
  }
  return s;
}

function initGL() {
  var canvas = document.createElement('canvas');
  canvas.id = 'gl';
  // preserveDrawingBuffer so a rendered frame survives long enough to be read
  // back for the reviewability test and exported as a film-strip thumbnail.
  var gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('this browser has no WebGL2 — open the review in Chrome, Edge, Firefox or Safari 15+');
  var prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  var loc = {};
  var names = ['uImage', 'uDetail', 'uCurve', 'uWb', 'uDither', 'uMono', 'uAnchor'].concat(UNIFORMS);
  for (var i = 0; i < names.length; i++) loc[names[i]] = gl.getUniformLocation(prog, names[i]);
  // An array uniform is looked up by its first element, never by its bare name.
  loc.uMix = gl.getUniformLocation(prog, 'uMix[0]');
  gl.uniform1i(loc.uImage, 0);
  gl.uniform1i(loc.uDetail, 1);
  gl.uniform1i(loc.uCurve, 2);
  gl.bindVertexArray(gl.createVertexArray());
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(QUAD), gl.STATIC_DRAW);
  var aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  G = { gl: gl, canvas: canvas, prog: prog, loc: loc };
}

/**
 * Draw a 2x2 texture of known colours and read back the corners.
 *
 * Everything above this line is arithmetic that can be checked without a GPU;
 * everything below depends on the driver actually drawing the quad where the
 * shader says. This is the one thing that cannot be tested anywhere but here, so
 * it is tested here — and it is what caught the geometry being wrong on this
 * machine while every buffer and every upload was correct.
 *
 * Returns null when the corners land where they should.
 */
function selfTest() {
  var gl = G.gl;
  var probe = {
    width: 2, height: 2,
    ramp: { samples: [{ scale: 0, value: 0, wb: [1, 1, 1], u: {} }, { scale: 1, value: 0, wb: [1, 1, 1], u: {} }] },
    // Top-left red, top-right green, bottom-left blue, bottom-right white.
    image: texture(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT, 2, 2, new Float32Array([
      1, 0, 0, 1,  0, 1, 0, 1,
      0, 0, 1, 1,  1, 1, 1, 1
    ])),
    detail: texture(gl, gl.RG32F, gl.RG, gl.FLOAT, 2, 2, new Float32Array(8)),
    curve: curveTexture(gl, [], [0, 0, 0, 0]),
    anchor: 0
  };
  var px = new Uint8Array(16);
  var read = function () {
    draw(probe, { wb: [1, 1, 1], u: {} }, false);
    gl.readPixels(0, 0, 2, 2, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };

  // 1. Geometry: is the quad where the shader put it?
  read();
  // readPixels is bottom-up, so row 0 here is the bottom of the image.
  var brightest = function (o) {
    var c = [px[o], px[o + 1], px[o + 2]];
    var m = Math.max(c[0], c[1], c[2]);
    return c[0] === m && c[1] === m && c[2] === m ? 'white' : c[0] === m ? 'red' : c[1] === m ? 'green' : 'blue';
  };
  var got = [brightest(8), brightest(12), brightest(0), brightest(4)].join(',');
  if (got !== 'red,green,blue,white') return 'corners came back ' + got + ', expected red,green,blue,white';

  // 2. Monochrome: with the conversion on and a flat mix, three primaries must
  // come back grey. This is here because it did not, silently — the shader
  // compiled, linked, reported no error, and rendered every black-and-white
  // frame in colour. A feature that can fail without saying so has to be asked.
  probe.ramp.mono = [0, 0, 0, 0, 0, 0, 0, 0];
  read();
  for (var p = 0; p < 16; p += 4) {
    var spread = Math.max(px[p], px[p + 1], px[p + 2]) - Math.min(px[p], px[p + 1], px[p + 2]);
    if (spread > 2) {
      return 'the black-and-white conversion is not being applied — a primary came back as ' +
        px[p] + ',' + px[p + 1] + ',' + px[p + 2] + ' instead of a grey';
    }
  }
  return null;
}

function texture(gl, internal, format, type, w, h, data) {
  var t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
  var err = gl.getError();
  if (err !== gl.NO_ERROR) throw new Error('texture ' + w + 'x' + h + ' rejected: GL error ' + err);
  return t;
}

/* ── Local contrast, precomputed once ───────────────────────────────────── */

/** Separable box blur, three passes — close enough to a Gaussian to be one. */
function blur(src, w, h, radius) {
  var a = Float32Array.from(src);
  var b = new Float32Array(w * h);
  for (var pass = 0; pass < 3; pass++) {
    // Horizontal, then vertical, each as a running sum so cost is independent
    // of the radius — the coarse scale is ~25px and must not cost 25x.
    for (var y = 0; y < h; y++) {
      var row = y * w;
      var sum = 0;
      for (var i = -radius; i <= radius; i++) sum += a[row + Math.min(w - 1, Math.max(0, i))];
      for (var x = 0; x < w; x++) {
        b[row + x] = sum / (radius * 2 + 1);
        sum -= a[row + Math.min(w - 1, Math.max(0, x - radius))];
        sum += a[row + Math.min(w - 1, Math.max(0, x + radius + 1))];
      }
    }
    for (var x2 = 0; x2 < w; x2++) {
      var sum2 = 0;
      for (var j = -radius; j <= radius; j++) sum2 += b[Math.min(h - 1, Math.max(0, j)) * w + x2];
      for (var y2 = 0; y2 < h; y2++) {
        a[y2 * w + x2] = sum2 / (radius * 2 + 1);
        sum2 -= b[Math.min(h - 1, Math.max(0, y2 - radius)) * w + x2];
        sum2 += b[Math.min(h - 1, Math.max(0, y2 + radius + 1)) * w + x2];
      }
    }
  }
  return a;
}

/**
 * The two local-contrast scales Texture and Clarity work on.
 *
 * Taken on the untouched frame and never recomputed. Exposure multiplies the
 * image by a constant, which is an additive shift in log2 and cancels exactly in
 * (luma - blurred luma); white balance is per-channel so it cancels only where a
 * pixel and its neighbourhood share a colour, which is nearly everywhere and
 * wrong by a hair at a strong colour edge. Recomputing two blurs per slider
 * move to chase that would cost more than it buys.
 */
function detailTexture(gl, rgb, w, h) {
  var logLuma = new Float32Array(w * h);
  // 256 bins over the sensor's 16 stops: enough to place a percentile within a
  // sixteenth of a stop, and one pass instead of sorting two million samples.
  var hist = new Uint32Array(256);
  for (var i = 0; i < w * h; i++) {
    var y = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
    var v = Math.log2(Math.max(y / 65535, 1e-7));
    logLuma[i] = v;
    hist[Math.min(255, Math.max(0, Math.round((v + 16) * 16)))]++;
  }
  // This frame's white: the 99th percentile, not the maximum. A single clipped
  // speculars or a dead pixel would otherwise define where "the highlights" are
  // for the whole photograph.
  var target = w * h * 0.99;
  var seen = 0;
  var anchor = 0;
  for (var b = 0; b < 256; b++) {
    seen += hist[b];
    if (seen >= target) { anchor = b / 16 - 16; break; }
  }
  var edge = Math.min(w, h);
  var fine = blur(logLuma, w, h, Math.max(1, Math.round(edge / 250)));
  var coarse = blur(logLuma, w, h, Math.max(4, Math.round(edge / 25)));
  var out = new Float32Array(w * h * 2);
  for (var k = 0; k < w * h; k++) {
    out[k * 2] = logLuma[k] - fine[k];
    out[k * 2 + 1] = logLuma[k] - coarse[k];
  }
  return { texture: texture(gl, gl.RG32F, gl.RG, gl.FLOAT, w, h, out), anchor: anchor };
}

/* ── Curves ─────────────────────────────────────────────────────────────── */

/** Hann window, so the four parametric regions overlap and sum to about one. */
function window4(x, centre) {
  var t = (x - centre) / 0.25;
  return Math.abs(t) >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * t));
}

/**
 * The parametric curve and the point curve, combined into one 256-entry table.
 *
 * Order matters and follows Camera Raw: the parametric regions shape the
 * picture first, the point curve is drawn on top of the result.
 */
function curveTexture(gl, knots, parametric) {
  var lut = new Float32Array(256);
  var centres = [0.875, 0.625, 0.375, 0.125]; // highlights, lights, darks, shadows
  for (var i = 0; i < 256; i++) {
    var x = i / 255;
    var v = x;
    for (var r = 0; r < 4; r++) v += parametric[r] * 0.16 * window4(x, centres[r]);
    v = Math.min(1, Math.max(0, v));
    if (knots.length > 1) v = sampleKnots(knots, v * 255) / 255;
    lut[i] = Math.min(1, Math.max(0, v));
  }
  return texture(gl, gl.R32F, gl.RED, gl.FLOAT, 256, 1, lut);
}

function sampleKnots(knots, x) {
  if (x <= knots[0][0]) return knots[0][1];
  for (var i = 1; i < knots.length; i++) {
    if (x <= knots[i][0]) {
      var x0 = knots[i - 1][0], y0 = knots[i - 1][1], x1 = knots[i][0], y1 = knots[i][1];
      return y0 + (y1 - y0) * (x1 === x0 ? 0 : (x - x0) / (x1 - x0));
    }
  }
  return knots[knots.length - 1][1];
}

/* ── Rendering ──────────────────────────────────────────────────────────── */

/**
 * Size the canvas to fit inside the stage, in CSS pixels, computed here.
 *
 * This was CSS to begin with and CSS could not do it. A max-height of 100% on a
 * replaced element resolves against the parent's height, and the stage is a grid
 * item with an automatic height — indefinite, so the constraint is dropped
 * entirely. A landscape frame happened to be narrow enough that max-width
 * alone contained it; a portrait one kept its full 1800px and ran off the bottom
 * of the screen. Measuring the box and doing the arithmetic is both shorter than
 * the CSS was and the only version that is true for both orientations.
 *
 * Never enlarged: a frame smaller than the stage keeps its own size, so a small
 * preview stays small and sharp instead of being stretched into mush.
 */
function fitCanvas(frame) {
  // Measured on the stage *container*, never on the stage itself: the stage is
  // sized by its content, so asking it how much room there is while the canvas
  // is inside it asks the canvas how big the canvas should be.
  var style = getComputedStyle(stagesEl);
  var room = {
    w: stagesEl.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    h: stagesEl.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  };
  if (!(room.w > 0) || !(room.h > 0)) return;
  var scale = Math.min(1, room.w / frame.width, room.h / frame.height);
  G.canvas.style.width = Math.floor(frame.width * scale) + 'px';
  G.canvas.style.height = Math.floor(frame.height * scale) + 'px';
}

function draw(frame, sample, dither) {
  var gl = G.gl;
  if (G.canvas.width !== frame.width || G.canvas.height !== frame.height) {
    G.canvas.width = frame.width;
    G.canvas.height = frame.height;
    fitCanvas(frame);
  }
  gl.viewport(0, 0, frame.width, frame.height);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frame.image);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, frame.detail);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, frame.curve);
  gl.uniform3f(G.loc.uWb, sample.wb[0], sample.wb[1], sample.wb[2]);
  gl.uniform1f(G.loc.uDither, dither ? 1 : 0);
  // The mix belongs to the frame, not to the slider position: a control scales
  // its own anchors and the black-and-white conversion is not one of them.
  var mono = frame.ramp && frame.ramp.mono;
  gl.uniform1f(G.loc.uMono, mono ? 1 : 0);
  gl.uniform1fv(G.loc.uMix, mono || [0, 0, 0, 0, 0, 0, 0, 0]);
  gl.uniform1f(G.loc.uAnchor, frame.anchor || 0);
  for (var i = 0; i < SLIDERS.length; i++) gl.uniform1f(G.loc[UNIFORMS[i]], sample.u[SLIDERS[i]] || 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/** The sample at an arbitrary intensity, interpolated between the two nearest. */
function sampleAt(ramp, scale) {
  var s = ramp.samples;
  var last = s.length - 1;
  var t = (scale - s[0].scale) / (s[last].scale - s[0].scale) * last;
  var i = Math.min(last - 1, Math.max(0, Math.floor(t)));
  var f = Math.min(1, Math.max(0, t - i));
  var a = s[i], b = s[i + 1];
  var u = {};
  for (var k = 0; k < SLIDERS.length; k++) {
    var name = SLIDERS[k];
    u[name] = (a.u[name] || 0) + ((b.u[name] || 0) - (a.u[name] || 0)) * f;
  }
  return {
    scale: scale,
    value: a.value + (b.value - a.value) * f,
    wb: [a.wb[0] + (b.wb[0] - a.wb[0]) * f, a.wb[1] + (b.wb[1] - a.wb[1]) * f, a.wb[2] + (b.wb[2] - a.wb[2]) * f],
    u: u
  };
}

/**
 * Where a slider value sits on the ramp, searching by value rather than scale.
 *
 * The first interval that contains the value wins, and that matters at the ends:
 * a parameter clamped at its limit — Exposure stops at −5 EV — is produced by
 * every intensity from the one that first reached it onward. Answering with the
 * smallest of them is the honest reading. The reviewer asked for a picture, and
 * the smallest multiplier that produces it is the least this catalog has to be
 * pushed to get there.
 */
function scaleForValue(ramp, value) {
  var s = ramp.samples;
  for (var i = 1; i < s.length; i++) {
    var a = s[i - 1], b = s[i];
    var lo = Math.min(a.value, b.value), hi = Math.max(a.value, b.value);
    if (value >= lo && value <= hi) {
      var span = b.value - a.value;
      return Math.abs(span) < 1e-9 ? a.scale : a.scale + (b.scale - a.scale) * ((value - a.value) / span);
    }
  }
  // Outside the ramp altogether: the reviewer dragged past the end, so take
  // whichever end they are nearer.
  var toFirst = Math.abs(value - s[0].value);
  var toLast = Math.abs(value - s[s.length - 1].value);
  return toFirst <= toLast ? s[0].scale : s[s.length - 1].scale;
}

/**
 * How much the picture changes between the control off and as fitted.
 *
 * The 95th percentile of the per-pixel difference, not the mean. These controls
 * are regional — Highlights acts on the bright end, Blacks on the dark one — so
 * averaging over every pixel dilutes the effect by however much of the frame the
 * control does not touch, and judges a highlight control by what it does to the
 * shadows. A change that is 1% on average and 15% where it acts is plainly
 * visible, and the mean would hide it.
 *
 * This test lives in the browser because it is a question about the *rendered*
 * picture, and the renderer is here. Asking it of a different pipeline than the
 * one on screen would answer about a picture nobody is looking at.
 */
function visibleChange(frame) {
  var gl = G.gl;
  var n = frame.width * frame.height * 4;
  var off = new Uint8Array(n), on = new Uint8Array(n);
  draw(frame, sampleAt(frame.ramp, 0), false);
  gl.readPixels(0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, off);
  draw(frame, sampleAt(frame.ramp, 1), false);
  gl.readPixels(0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, on);
  // Counting sort over the 256 possible differences: exact, and cheaper than
  // sorting a few million samples.
  var hist = new Uint32Array(256);
  var counted = 0;
  for (var i = 0; i < n; i++) {
    if ((i & 3) === 3) continue; // alpha
    hist[Math.abs(off[i] - on[i])]++;
    counted++;
  }
  var seen = 0;
  for (var d = 0; d < 256; d++) {
    seen += hist[d];
    if (seen >= counted * 0.95) return d / 255;
  }
  return 1;
}

/* ── Loading ────────────────────────────────────────────────────────────── */

/**
 * Frame data, fetched under a URL nothing has ever cached.
 *
 * Frames are addressed by position and the positions restart at zero on every
 * run, so /ramp/5 names a different photograph each time — and a browser that
 * kept the previous one has no way to know. Earlier runs served these with
 * max-age, and a stored response that has not expired is used *without asking
 * the server*: no header sent later can reach it, because no request is ever
 * made. This cost most of an afternoon of debugging a renderer that was correct,
 * against data from a review that had already ended. Stamping the run into the
 * query makes every URL new, which no cache can second-guess.
 */
function frameUrl(kind, id) {
  return '/' + kind + '/' + id + '?run=' + encodeURIComponent(DATA.run);
}

async function loadFrame(step) {
  var gl = G.gl;
  var responses = await Promise.all([fetch(frameUrl('pixels', step.id)), fetch(frameUrl('ramp', step.id))]);
  if (!responses[0].ok || !responses[1].ok) throw new Error('frame ' + step.id + ' failed to load');
  var buffers = await Promise.all([responses[0].arrayBuffer(), responses[1].json()]);
  var rgb = new Uint16Array(buffers[0]);
  var ramp = buffers[1];
  var w = step.width, h = step.height;

  // Scene-linear, straight from the RAW developer. Uploaded as float rather
  // than normalised into 8 bits, which is the whole point: nothing between the
  // decode and the display transform has a ceiling.
  var rgba = new Float32Array(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    rgba[i * 4] = rgb[i * 3] / 65535;
    rgba[i * 4 + 1] = rgb[i * 3 + 1] / 65535;
    rgba[i * 4 + 2] = rgb[i * 3 + 2] / 65535;
    rgba[i * 4 + 3] = 1;
  }
  var detail = detailTexture(gl, rgb, w, h);
  return {
    step: step,
    width: w,
    height: h,
    ramp: ramp,
    /** Where this frame's own white sits, in log2 — see uAnchor in the shader. */
    anchor: detail.anchor,
    // Full float storage. Half would be plenty for the data — scene-linear
    // values keep their precision in the exponent — but 32F is the combination
    // every WebGL2 implementation takes without argument, and this is not the
    // place to be clever about memory.
    image: texture(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT, w, h, rgba),
    detail: detail.texture,
    curve: curveTexture(gl, ramp.curve, ramp.parametric)
  };
}

/* ── UI ─────────────────────────────────────────────────────────────────── */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(step, value) {
  return value.toFixed(step.decimals) + step.unit;
}

function buildUI() {
  stagesEl.innerHTML = '';
  asideEl.innerHTML = '';
  stripEl.innerHTML = '';
  frames.forEach(function (frame, i) {
    var step = frame.step;

    var fig = document.createElement('figure');
    fig.className = 'stage';
    fig.dataset.index = String(i);
    if (i !== 0) fig.hidden = true;
    stagesEl.appendChild(fig);
    frame.stage = fig;

    var panel = document.createElement('div');
    panel.className = 'control';
    panel.dataset.index = String(i);
    if (i !== 0) panel.hidden = true;
    panel.innerHTML =
      (step.treatment ? '<p class="treatment">' + esc(step.treatment) + '</p>' : '') +
      '<h2>' + esc(step.label) + '</h2>' +
      '<p class="why">' + esc(step.caption) + '</p>' +
      '<output>' + esc(fmt(step, step.fitted)) + '</output>' +
      '<input type="range" min="' + step.min + '" max="' + step.max + '" step="' +
        (step.decimals > 0 ? 0.01 : 1) + '" value="' + step.fitted + '">' +
      '<div class="ends"><span>' + esc(fmt(step, step.min)) + '</span><span>' + esc(fmt(step, step.max)) + '</span></div>' +
      '<p class="hint">fitted <b>' + esc(fmt(step, step.fitted)) + '</b> · off <b>' + esc(fmt(step, step.zero)) + '</b></p>' +
      (frame.change < DATA.threshold
        ? '<p class="inert">Moving this slider changes the photograph by ' + (frame.change * 100).toFixed(1) +
          '% — too little to judge by eye. Its fitted gain is small, or this frame has nothing for it to act on.</p>'
        : '') +
      '<button class="ghost">Reset to fitted</button>';
    asideEl.appendChild(panel);

    var range = panel.querySelector('input');
    var out = panel.querySelector('output');
    frame.range = range;
    range.addEventListener('input', function () {
      var value = parseFloat(range.value);
      out.textContent = fmt(step, value);
      chosen[step.family] = scaleForValue(frame.ramp, value);
      paint(i);
    });
    panel.querySelector('button').addEventListener('click', function () {
      range.value = String(step.fitted);
      out.textContent = fmt(step, step.fitted);
      chosen[step.family] = 1;
      paint(i);
    });

    var thumb = document.createElement('button');
    thumb.className = 'thumb' + (i === 0 ? ' current' : '');
    thumb.title = step.label;
    thumb.dataset.go = String(i);
    thumb.innerHTML = '<img alt=""><span>' + esc(step.label) + (step.treatment ? ' · ' + esc(step.treatment === 'black-and-white' ? 'B&W' : 'colour') : '') + '</span>';
    thumb.addEventListener('click', function () { show(i); });
    stripEl.appendChild(thumb);
    frame.thumbImg = thumb.querySelector('img');
  });
}

/* ── The loupe ──────────────────────────────────────────────────────────── */

/**
 * A window onto the rendered pixels at 1:1, wherever the pointer is.
 *
 * **It magnifies nothing.** The frame is decoded well above what fits on screen
 * and the stage shrinks it to fit; the loupe simply declines to shrink, so what
 * it shows is pixels that were rendered, not pixels that were invented by
 * scaling up the ones on screen. That is the whole point for Dehaze and
 * Clarity — the controls whose damage is haloing and mush at the detail scale,
 * which is exactly the scale a fit-to-window view averages away. The readout
 * says how much bigger than the stage that works out to.
 *
 * It sits in a corner rather than under the pointer: a loupe centred on the
 * cursor covers the thing being examined, and a small box on the image marks
 * what is being shown instead.
 */
var loupe = { visible: false, size: 280, x: 0, y: 0, el: null, ctx: null, box: null, label: null };

function initLoupe() {
  var el = document.createElement('div');
  el.className = 'loupe';
  var canvas = document.createElement('canvas');
  canvas.width = loupe.size;
  canvas.height = loupe.size;
  var label = document.createElement('span');
  el.appendChild(canvas);
  el.appendChild(label);
  stagesEl.appendChild(el);
  var box = document.createElement('div');
  box.className = 'loupe-box';
  document.body.appendChild(box);
  loupe.el = el;
  loupe.box = box;
  loupe.label = label;
  loupe.ctx = canvas.getContext('2d');

  G.canvas.addEventListener('mousemove', function (e) {
    loupe.x = e.clientX;
    loupe.y = e.clientY;
    loupe.visible = true;
    el.style.display = 'block';
    box.style.display = 'block';
    drawLoupe(frames[at]);
  });
  G.canvas.addEventListener('mouseleave', hideLoupe);
}

function hideLoupe() {
  loupe.visible = false;
  if (loupe.el) loupe.el.style.display = 'none';
  if (loupe.box) loupe.box.style.display = 'none';
}

function drawLoupe(frame) {
  var rect = G.canvas.getBoundingClientRect();
  if (!rect.width) return;
  // Display pixels per rendered pixel. Below 1 the stage is shrinking the
  // frame, and 1/scale is what the loupe gives back.
  var scale = rect.width / G.canvas.width;
  var side = Math.min(loupe.size, G.canvas.width, G.canvas.height);
  var nx = (loupe.x - rect.left) / scale - side / 2;
  var ny = (loupe.y - rect.top) / scale - side / 2;
  var sx = Math.max(0, Math.min(G.canvas.width - side, nx));
  var sy = Math.max(0, Math.min(G.canvas.height - side, ny));
  loupe.ctx.clearRect(0, 0, loupe.size, loupe.size);
  loupe.ctx.drawImage(G.canvas, sx, sy, side, side, 0, 0, side, side);
  loupe.label.textContent = (1 / scale).toFixed(1) + '× · ' + Math.round(side) + 'px';
  loupe.box.style.left = (rect.left + sx * scale) + 'px';
  loupe.box.style.top = (rect.top + sy * scale) + 'px';
  loupe.box.style.width = (side * scale) + 'px';
  loupe.box.style.height = (side * scale) + 'px';
}

/**
 * Repaint one frame. One draw call, straight onto the canvas the reviewer is
 * looking at — the canvas lives in the page rather than being encoded into an
 * image per repaint. At 1800px that encode was 100ms and change, which is the
 * difference between a slider that tracks a hand and one that lurches after it.
 */
function paint(index) {
  var frame = frames[index];
  draw(frame, sampleAt(frame.ramp, chosen[frame.step.family]), true);
  if (loupe.visible) drawLoupe(frame);
}

function show(index) {
  at = index;
  var nodes = document.querySelectorAll('.stage, .control');
  for (var i = 0; i < nodes.length; i++) nodes[i].hidden = Number(nodes[i].dataset.index) !== index;
  var thumbs = document.querySelectorAll('.thumb');
  for (var j = 0; j < thumbs.length; j++) thumbs[j].classList.toggle('current', Number(thumbs[j].dataset.go) === index);
  // One canvas, moved to whichever stage is on screen: five WebGL contexts to
  // show one photograph at a time would be five times the GPU memory for
  // nothing, and browsers cap how many a page may hold.
  frames[index].stage.appendChild(G.canvas);
  hideLoupe();
  paint(index);
  // After the move, because the stage it just entered is the one whose room
  // matters, and on every resize for the same reason.
  fitCanvas(frames[index]);
}

window.addEventListener('resize', function () {
  if (frames.length) fitCanvas(frames[at]);
});

function fail(message) {
  bootEl.hidden = false;
  bootEl.textContent = message;
}

async function boot() {
  try {
    initGL();
  } catch (e) {
    fail(e.message);
    return;
  }
  var candidates = DATA.steps;
  var kept = [];
  // What the browser did with each candidate, reported back so the terminal
  // does not announce five controls while the screen shows one. Only this side
  // knows: whether a control is worth offering is decided by the render.
  var report = { run: DATA.run, renderer: String(G.gl.getParameter(G.gl.RENDERER)), steps: [] };
  var broken = selfTest();
  report.selfTest = broken || 'ok';
  if (broken) {
    // Nothing below this point can be trusted if the quad is not where the
    // shader put it, and a wrong picture calibrated confidently is worse than
    // no picture at all.
    fetch('/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    fail('This browser is not drawing correctly — ' + broken + '. Nothing here can be trusted, so nothing is shown. The fitted values are kept.');
    return;
  }
  for (var i = 0; i < candidates.length; i++) {
    bootEl.textContent = 'Preparing ' + candidates[i].label + '… (' + (i + 1) + ' of ' + candidates.length + ')';
    var frame;
    try {
      frame = await loadFrame(candidates[i]);
    } catch (e) {
      report.steps.push({ label: candidates[i].label, dropped: 'failed to load: ' + e.message });
      continue;
    }
    // How much the control moves its own frame, measured but no longer used to
    // hide it. Dropping half the controls silently left the screen contradicting
    // the terminal and gave no way to tell a control that does nothing from a
    // control that is missing. Every anchored parameter the profile carries is
    // offered; the ones that barely move say so on their own panel, and the
    // decision is the reviewer's.
    var change = visibleChange(frame);
    var err = G.gl.getError();
    if (err !== G.gl.NO_ERROR) {
      report.steps.push({ label: candidates[i].label, dropped: 'GL error ' + err });
      continue;
    }
    frame.change = change;
    report.steps.push({
      label: candidates[i].label,
      change: change,
      size: frame.width + 'x' + frame.height,
      // Read back from the linked program, not from the variable that was meant
      // to set it: the whole point is to find out where the two stop agreeing.
      mono: (frame.ramp.mono ? 'sent' : 'none') + '/' + String(G.gl.getUniform(G.prog, G.loc.uMono)),
    });
    kept.push(frame);
  }
  frames = kept;
  if (frames.length === 0) {
    fail('No frame could be rendered — close this tab and the fitted values are kept.');
    return;
  }
  for (var k = 0; k < frames.length; k++) chosen[frames[k].step.family] = 1;
  buildUI();
  initLoupe();
  // Thumbnails at the fitted values: they are for navigation, and repainting
  // five of them on every slider move would cost five times what repainting the
  // one frame being judged costs. Scaled down through a 2D canvas first, so
  // what gets encoded is a 164px thumbnail and not an 1800px frame.
  bootEl.hidden = true;
  document.getElementById('main').hidden = false;
  stripEl.hidden = false;
  show(0);

  var small = document.createElement('canvas');
  var ctx = small.getContext('2d');
  for (var t = 0; t < frames.length; t++) {
    draw(frames[t], sampleAt(frames[t].ramp, 1), true);
    // finish(), not flush(): drawImage must read a surface the GPU has actually
    // finished writing, and the two calls are not the same promise.
    G.gl.finish();
    small.width = 164;
    small.height = Math.max(1, Math.round((164 * frames[t].height) / frames[t].width));
    ctx.drawImage(G.canvas, 0, 0, small.width, small.height);
    frames[t].thumbImg.src = small.toDataURL('image/jpeg', 0.72);
  }
  // The strip left the canvas showing the last frame it drew; put the one on
  // screen back.
  show(0);

  // A contact sheet of what this GPU actually produced, sent home with the
  // report. Nothing else can answer "is it rendering correctly" from a terminal:
  // the renderer is in the browser, and a description of a wrong image is not
  // the image. Every kept frame, not just the first — the one that was wrong
  // here was a black-and-white frame rendering in colour, four along.
  var CELL = 240;
  var shot = document.createElement('canvas');
  shot.width = CELL * Math.min(frames.length, 6);
  shot.height = CELL;
  var sheet = shot.getContext('2d');
  for (var s = 0; s < frames.length && s < 6; s++) {
    draw(frames[s], sampleAt(frames[s].ramp, chosen[frames[s].step.family]), false);
    G.gl.finish();
    var scale = Math.min(CELL / frames[s].width, CELL / frames[s].height);
    var w = frames[s].width * scale;
    var h = frames[s].height * scale;
    sheet.drawImage(G.canvas, s * CELL + (CELL - w) / 2, (CELL - h) / 2, w, h);
  }
  report.shot = shot.toDataURL('image/jpeg', 0.85);
  show(at);
  report.canvas = G.canvas.width + 'x' + G.canvas.height + ' shown at ' + G.canvas.style.width + ' x ' + G.canvas.style.height;
  fetch('/diag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
}

document.addEventListener('keydown', function (e) {
  if (!frames.length) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') show(Math.min(frames.length - 1, at + 1));
  if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') show(Math.max(0, at - 1));
});

document.getElementById('save').addEventListener('click', async function () {
  statusEl.textContent = 'Saving…';
  var body = {};
  for (var key in chosen) body[key] = chosen[key];
  var r = await fetch('/save', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  statusEl.textContent = r.ok ? 'Saved — you can close this tab.' : 'Save failed.';
});

boot();
`;
