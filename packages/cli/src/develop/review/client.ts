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
import { FRAGMENT_SHADER, VERTEX_SHADER } from './glsl.js';

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
  var names = ['uImage', 'uDetail', 'uCurve', 'uWb', 'uDither'].concat(UNIFORMS);
  for (var i = 0; i < names.length; i++) loc[names[i]] = gl.getUniformLocation(prog, names[i]);
  gl.uniform1i(loc.uImage, 0);
  gl.uniform1i(loc.uDetail, 1);
  gl.uniform1i(loc.uCurve, 2);
  // The vertex shader builds its own triangle from gl_VertexID, so there is no
  // buffer to bind — but a VAO must still be bound for the draw to be valid.
  gl.bindVertexArray(gl.createVertexArray());
  G = { gl: gl, canvas: canvas, prog: prog, loc: loc };
}

function texture(gl, internal, format, type, w, h, data) {
  var t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
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
  for (var i = 0; i < w * h; i++) {
    var y = 0.2126 * rgb[i * 3] + 0.7152 * rgb[i * 3 + 1] + 0.0722 * rgb[i * 3 + 2];
    logLuma[i] = Math.log2(Math.max(y / 65535, 1e-7));
  }
  var edge = Math.min(w, h);
  var fine = blur(logLuma, w, h, Math.max(1, Math.round(edge / 250)));
  var coarse = blur(logLuma, w, h, Math.max(4, Math.round(edge / 25)));
  var out = new Float32Array(w * h * 2);
  for (var k = 0; k < w * h; k++) {
    out[k * 2] = logLuma[k] - fine[k];
    out[k * 2 + 1] = logLuma[k] - coarse[k];
  }
  // Half-float storage from float input: these are log2 differences of about
  // ±5, so ten bits of mantissa is far more than the eye can be shown, and it
  // halves what a 1800px frame costs on the GPU.
  return texture(gl, gl.RG16F, gl.RG, gl.FLOAT, w, h, out);
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

function draw(frame, sample, dither) {
  var gl = G.gl;
  if (G.canvas.width !== frame.width || G.canvas.height !== frame.height) {
    G.canvas.width = frame.width;
    G.canvas.height = frame.height;
    // Both ceilings at once. An inline max-width in pixels beats a stylesheet's
    // max-height:100% on specificity, so a portrait frame obeyed its own height
    // and ran straight out of the bottom of the stage; min() keeps the stage
    // and the frame's own size as limits together.
    G.canvas.style.maxWidth = 'min(100%, ' + frame.width + 'px)';
    G.canvas.style.maxHeight = 'min(100%, ' + frame.height + 'px)';
  }
  gl.viewport(0, 0, frame.width, frame.height);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, frame.image);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, frame.detail);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, frame.curve);
  gl.uniform3f(G.loc.uWb, sample.wb[0], sample.wb[1], sample.wb[2]);
  gl.uniform1f(G.loc.uDither, dither ? 1 : 0);
  for (var i = 0; i < SLIDERS.length; i++) gl.uniform1f(G.loc[UNIFORMS[i]], sample.u[SLIDERS[i]] || 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
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

async function loadFrame(step) {
  var gl = G.gl;
  var responses = await Promise.all([fetch('/pixels/' + step.id), fetch('/ramp/' + step.id)]);
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
  return {
    step: step,
    width: w,
    height: h,
    ramp: ramp,
    // Half-float, not full: scene-linear values carry their precision in the
    // exponent, so ten bits of mantissa is a constant 0.05% everywhere —
    // including the shadows, where a fixed-point buffer would run out first.
    image: texture(gl, gl.RGBA16F, gl.RGBA, gl.FLOAT, w, h, rgba),
    detail: detailTexture(gl, rgb, w, h),
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
      '<h2>' + esc(step.label) + '</h2>' +
      '<p class="why">' + esc(step.caption) + '</p>' +
      '<output>' + esc(fmt(step, step.fitted)) + '</output>' +
      '<input type="range" min="' + step.min + '" max="' + step.max + '" step="' +
        (step.decimals > 0 ? 0.01 : 1) + '" value="' + step.fitted + '">' +
      '<div class="ends"><span>' + esc(fmt(step, step.min)) + '</span><span>' + esc(fmt(step, step.max)) + '</span></div>' +
      '<p class="hint">fitted <b>' + esc(fmt(step, step.fitted)) + '</b> · off <b>' + esc(fmt(step, step.zero)) + '</b></p>' +
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
    thumb.innerHTML = '<img alt=""><span>' + esc(step.label) + '</span>';
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
}

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
  for (var i = 0; i < candidates.length; i++) {
    bootEl.textContent = 'Preparing ' + candidates[i].label + '… (' + (i + 1) + ' of ' + candidates.length + ')';
    var frame;
    try {
      frame = await loadFrame(candidates[i]);
    } catch (e) {
      continue;
    }
    // A control that does not visibly move its own frame is not offered at all:
    // a slider that appears to do nothing reads as broken, and the reviewer has
    // no way to tell that from a control whose anchor is simply small.
    if (visibleChange(frame) < DATA.threshold) continue;
    kept.push(frame);
  }
  frames = kept;
  if (frames.length === 0) {
    fail('None of the anchored controls change these photographs enough to be worth judging — close this tab and the fitted values are kept.');
    return;
  }
  for (var k = 0; k < frames.length; k++) chosen[frames[k].step.family] = 1;
  buildUI();
  initLoupe();
  // Thumbnails at the fitted values: they are for navigation, and repainting
  // five of them on every slider move would cost five times what repainting the
  // one frame being judged costs. Scaled down through a 2D canvas first, so
  // what gets encoded is a 164px thumbnail and not an 1800px frame.
  var small = document.createElement('canvas');
  var ctx = small.getContext('2d');
  for (var t = 0; t < frames.length; t++) {
    draw(frames[t], sampleAt(frames[t].ramp, 1), true);
    small.width = 164;
    small.height = Math.max(1, Math.round((164 * frames[t].height) / frames[t].width));
    ctx.drawImage(G.canvas, 0, 0, small.width, small.height);
    frames[t].thumbImg.src = small.toDataURL('image/jpeg', 0.72);
  }
  bootEl.hidden = true;
  document.getElementById('main').hidden = false;
  stripEl.hidden = false;
  show(0);
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
