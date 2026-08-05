/**
 * The develop pipeline, as a shader.
 *
 * This replaces a per-channel lookup table, and the replacement is not about
 * speed — it is about what a lookup table *cannot express*, which turned out to
 * be most of what the review screen is for:
 *
 * - **A table clips.** With 65536 entries it has to end somewhere, so the old
 *   one clamped scene-linear light to 1.0 before doing anything else. Highlight
 *   recovery then had nothing left to recover and every positive exposure step
 *   clipped instantly — the two controls the screen exists to calibrate. In
 *   float there is no such ceiling: values stay above white until the display
 *   transform at the very end.
 * - **A table is per-channel.** The tone controls therefore acted on red, green
 *   and blue independently, which shifts hue as it moves brightness. Here they
 *   act on *luminance* and apply one common gain to the three channels, which is
 *   both what a photographer expects and what every editor does.
 * - **A table cannot see its neighbours.** Clarity and Texture are local
 *   contrast, so they were simply not applied at all — two of the eleven
 *   controls on the screen rendered as no-ops. Here they are an unsharp mask
 *   over two precomputed scales.
 *
 * What is still approximate, stated plainly: Adobe does not document the PV2012
 * operators, so the shapes below are ours. They are, however, expressed in
 * physical units — a region gain is in **stops**, a pivot is a **log2 luminance**
 * — rather than as coefficients on an encoded value, which is what makes them
 * checkable against Lightroom one control at a time.
 *
 * Ordering follows a scene-referred pipeline: everything multiplicative happens
 * in linear light, the tonal shaping happens in log2 luminance, and only then is
 * the result handed to a display transform. Curves and colour, which Camera Raw
 * defines over encoded values, come after it.
 */

/**
 * A full-screen quad from a real vertex buffer.
 *
 * The obvious version of this builds its own geometry out of `gl_VertexID` and
 * needs no buffer at all. It is a common trick and it is not reliable: with no
 * array buffer bound, some drivers — ANGLE and SwiftShader among them, which is
 * what a browser falls back to — do not feed it a usable vertex index. The
 * geometry comes out wrong, so the interpolated UVs come out wrong, and the
 * frame renders as a squashed band repeated across the top of the canvas. Six
 * vertices in a buffer cost nothing and behave the same everywhere.
 *
 * `vUv` is flipped on y so row 0 of the uploaded buffer is the top of the image.
 */
export const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x, 1.0 - aPos.y);
  gl_Position = vec4(aPos * 2.0 - 1.0, 0.0, 1.0);
}`;

/** The quad's corners, as unit coordinates: two triangles, six vertices. */
export const QUAD = [0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1];

export const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uImage;   // scene-linear RGB, as the RAW developer produced it
uniform sampler2D uDetail;  // r = detail band (Texture), g = mid band (Clarity)
uniform sampler2D uCurve;   // 256x1: the point curve and the parametric curve, combined

uniform vec3  uWb;          // per-channel white-balance gain, unit luminance
uniform float uExposure;    // EV
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uClarity;
uniform float uTexture;
uniform float uDehaze;
uniform float uVibrance;
uniform float uSaturation;
uniform float uDither;      // 1 on screen, 0 when the frame is being measured
uniform float uMono;        // 1 when this frame is developed black-and-white
uniform float uMix[8];      // the black-and-white mix, by hue, each -1..1
/**
 * This frame's own white, as log2 luminance before exposure — its 99th
 * percentile, so one blown speculars does not define it.
 *
 * Every region below is placed relative to this rather than to the sensor's
 * white, and that is not a refinement, it is the difference between the controls
 * working and not. Measured on a real catalog, a night frame's median sits seven
 * stops under sensor white and 0.02% of its pixels reach a pivot fixed there:
 * Highlights had nothing to act on and the screen dropped it as a control that
 * does nothing. Camera Raw's highlights are the bright part of the *photograph*.
 */
uniform float uAnchor;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

/**
 * How far each control moves the picture at full deflection.
 *
 * In stops, so they can be argued about. Highlights and Shadows compress or
 * expand their region rather than translating it, so their number is a
 * proportion of the distance from the pivot; Whites and Blacks translate an
 * endpoint, so theirs is an absolute shift.
 */
const float HIGHLIGHT_RANGE = 0.55;  // proportion of the distance above its pivot
const float SHADOW_RANGE    = 0.55;
const float WHITE_STOPS     = 1.10;
const float BLACK_STOPS     = 1.10;
const float CONTRAST_RANGE  = 0.45;  // proportion of the distance from middle grey
const float CLARITY_STOPS   = 0.90;
const float TEXTURE_STOPS   = 0.80;
/** Fraction of the frame's white mixed in (or taken out) at full deflection. */
const float DEHAZE_VEIL     = 0.45;

/**
 * Where each region sits, in stops below this frame's own white.
 *
 * Middle grey is 2.47 stops down by definition (0.18 of white); the rest are
 * placed around it the way the panel's four controls divide a histogram.
 */
const float HIGHLIGHT_PIVOT = -3.20;
const float SHADOW_PIVOT    = -4.60;
const float GREY_BELOW_WHITE = -2.4739;

/**
 * Soft limit for a local-contrast term.
 *
 * An unsharp mask applied flat produces halos at strong edges, because that is
 * exactly where the difference from the blur is largest. tanh leaves small
 * differences — the texture the control is for — untouched, and rolls the large
 * ones off.
 */
float soften(float d, float limit) { return limit * tanh(d / limit); }

/** How far one black-and-white mix slider may push its hue, at full deflection. */
const float MIX_STOPS = 0.85;

/** Hue in degrees, from linear RGB. Zero saturation returns zero, harmlessly. */
float hueOf(vec3 c) {
  float hi = max(max(c.r, c.g), c.b);
  float lo = min(min(c.r, c.g), c.b);
  float d = hi - lo;
  if (d <= 0.0) return 0.0;
  float h = hi == c.r ? mod((c.g - c.b) / d, 6.0)
          : hi == c.g ? (c.b - c.r) / d + 2.0
                      : (c.r - c.g) / d + 4.0;
  return h * 60.0;
}

/**
 * The mix weight at one hue, interpolated between the two nearest sliders.
 *
 * Camera Raw's eight channels do not sit at even intervals — red, orange and
 * yellow are 30 degrees apart while green to aqua is 60 — so the weight has to
 * be interpolated between neighbours rather than binned. Magenta wraps back
 * round to red.
 *
 * Written out rather than looped over an array on purpose. The loop version
 * indexed a local array one past its end on the last
 * iteration: undefined behaviour, and whatever the driver did with it, the whole
 * monochrome branch stopped taking effect on this machine while the shader still
 * compiled and linked without a word. Constant indices cannot do that.
 */
float mixAt(float h) {
  if (h <  30.0) return mix(uMix[0], uMix[1], (h -   0.0) / 30.0);
  if (h <  60.0) return mix(uMix[1], uMix[2], (h -  30.0) / 30.0);
  if (h < 120.0) return mix(uMix[2], uMix[3], (h -  60.0) / 60.0);
  if (h < 180.0) return mix(uMix[3], uMix[4], (h - 120.0) / 60.0);
  if (h < 240.0) return mix(uMix[4], uMix[5], (h - 180.0) / 60.0);
  if (h < 270.0) return mix(uMix[5], uMix[6], (h - 240.0) / 30.0);
  if (h < 300.0) return mix(uMix[6], uMix[7], (h - 270.0) / 30.0);
  return mix(uMix[7], uMix[0], (h - 300.0) / 60.0);
}

void main() {
  vec3 lin = texture(uImage, vUv).rgb * uWb * exp2(uExposure);

  /**
   * Dehaze, as the veil it is.
   *
   * Haze is light scattered *into* the path: it adds a fraction of a bright
   * atmospheric colour to everything, which is why a hazy scene has a lifted
   * black point, less contrast and less saturation. So adding it is a mix toward
   * that colour and removing it is that mix inverted — the same equation, read
   * in both directions:
   *
   *     add     out = in·(1+v) − v·A        (v < 0)
   *     remove  out = (in − v·A) / (1 − v)  (v > 0)
   *
   * Negative therefore lays white over the picture, which is what negative
   * Dehaze does and what the previous version did not: it inverted large-scale
   * local contrast instead, so turning it down produced a glow rather than a
   * veil. That is Clarity's mechanism, not this one.
   *
   * A is the frame's own white. The model is global — real haze thickens with
   * distance and this does not know depth — so the amount is right and the
   * distribution is flat.
   */
  float veil = uDehaze * DEHAZE_VEIL;
  float A = exp2(uAnchor + uExposure);
  lin = veil > 0.0 ? (lin - veil * A) / (1.0 - veil) : lin * (1.0 + veil) - veil * A;
  lin = max(lin, 0.0);

  // Black and white, before anything tonal: from here on the frame is the
  // photograph being judged, and every control below acts on its luminance.
  // Weighted by the pixel's own saturation, so a grey wall is not moved by a
  // slider that exists to separate a red coat from a green one.
  if (uMono > 0.5) {
    float peak = max(max(lin.r, lin.g), lin.b);
    float sat = peak > 0.0 ? (peak - min(min(lin.r, lin.g), lin.b)) / peak : 0.0;
    lin = vec3(dot(lin, LUMA) * exp2(mixAt(hueOf(lin)) * MIX_STOPS * sat));
  }

  float y = max(dot(lin, LUMA), 1e-7);
  float l = log2(y);

  // The frame's white, carried along by exposure: raising exposure moves the
  // whole histogram, and the regions have to move with it or a +1 EV frame would
  // be judged against the darker frame's landmarks.
  float white = uAnchor + uExposure;
  float grey = white + GREY_BELOW_WHITE;

  // Local contrast. The blurs were taken once, on the untouched frame: white
  // balance and exposure multiply the image by a constant, which is an additive
  // shift in log — so it cancels in (l - blur) and the detail is invariant under
  // both. Nothing here has to be recomputed when a slider moves.
  vec2 detail = texture(uDetail, vUv).rg;
  float fine = soften(detail.r, 0.45);
  float coarse = soften(detail.g, 0.75);

  float dl = 0.0;

  // Two bands, two controls, no overlap: Texture has the detail, Clarity has the
  // band between detail and shape. Clarity is held back at the two ends, where
  // local contrast turns into haloing against a blown sky or a blocked shadow;
  // Texture works everywhere, because detail does.
  float midtones = smoothstep(white - 7.0, white - 4.5, l) * (1.0 - smoothstep(white - 1.6, white + 0.2, l));
  dl += uTexture * TEXTURE_STOPS * fine;
  dl += uClarity * CLARITY_STOPS * coarse * midtones;

  // Highlights and Shadows: compress or expand their region, anchored at a
  // pivot, so a negative Highlights pulls the bright end *toward* the pivot
  // instead of translating the whole upper range down. That is what makes it
  // read as recovery rather than as a darker picture.
  dl += uHighlights * HIGHLIGHT_RANGE * min(max(l - (white + HIGHLIGHT_PIVOT), 0.0), 4.0);
  dl -= uShadows * SHADOW_RANGE * min(max((white + SHADOW_PIVOT) - l, 0.0), 4.0);

  // Whites and Blacks: move an endpoint, weighted by a smooth mask so neither
  // has a visible boundary where it stops acting.
  dl += uWhites * WHITE_STOPS * smoothstep(white - 2.6, white + 0.2, l);
  dl += uBlacks * BLACK_STOPS * (1.0 - smoothstep(white - 7.5, white - 3.2, l));

  // Contrast, about middle grey. In log this is a straight gain on the distance
  // from grey, which is the shape a photographer means by "more contrast".
  float shaped = l + dl;
  shaped = grey + (shaped - grey) * (1.0 + uContrast * CONTRAST_RANGE);

  // Back to linear as a single gain on the three channels: luminance moved, hue
  // and saturation did not.
  lin *= exp2(shaped) / y;

  // Display transform. sRGB's transfer function gets us to encoded values; the
  // gentle S on top of it is the base rendering every editor applies and this
  // preview previously did not, which is why an untouched frame looked flat
  // here and normal everywhere else.
  vec3 enc;
  enc.r = clamp(lin.r, 0.0, 1.0);
  enc.g = clamp(lin.g, 0.0, 1.0);
  enc.b = clamp(lin.b, 0.0, 1.0);
  enc = mix(enc * 12.92, 1.055 * pow(max(enc, 0.0031308), vec3(1.0 / 2.4)) - 0.055,
            step(0.0031308, enc));
  const float BASE_CONTRAST = 0.30;
  enc = mix(enc, enc * enc * (3.0 - 2.0 * enc), BASE_CONTRAST);

  // Saturation and vibrance, on encoded values — which is where Camera Raw's
  // ±100 means what it means. Vibrance is the same move weighted toward the
  // *less* saturated pixels, which is what makes it protect skin.
  float sat = uSaturation + uDehaze * 0.25;
  if (sat != 0.0 || uVibrance != 0.0) {
    float grey = dot(enc, LUMA);
    float peak = max(max(enc.r, enc.g), enc.b);
    float current = peak > 0.0 ? (peak - min(min(enc.r, enc.g), enc.b)) / peak : 0.0;
    enc = clamp(vec3(grey) + (enc - grey) * (1.0 + sat + uVibrance * (1.0 - current)), 0.0, 1.0);
  }

  // The point curve and the parametric curve, combined into one table by the
  // client. Camera Raw defines both over 0..255 encoded, so this is the right
  // place for them and the only place they are exact.
  enc = vec3(texture(uCurve, vec2(enc.r, 0.5)).r,
             texture(uCurve, vec2(enc.g, 0.5)).r,
             texture(uCurve, vec2(enc.b, 0.5)).r);

  // A little noise, below one code value: after this much shaping an 8-bit
  // canvas bands visibly in a clear sky. Off while a frame is being measured, so
  // the reviewability test is not reading its own dither.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  fragColor = vec4(enc + (n - 0.5) * (uDither / 255.0), 1.0);
}`;
