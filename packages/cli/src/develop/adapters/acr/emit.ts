/**
 * Canonical develop edit → an Adobe Camera Raw sidecar.
 *
 * A Lightroom-readable `.xmp` is just an RDF wrapper around crs: attributes, so
 * we template it directly — no exiftool needed on the write side. Dropping one
 * next to a RAW gives the photographer a non-destructive starting point they can
 * accept or discard.
 */

import { CURVE_KNOTS, curveFromDevelop, curveParamKey, type Treatment } from '../../develop/schema.js';
import type { PredictedEdit } from '../types.js';

/** The synthetic per-knot keys, which are rebuilt into a Seq rather than emitted. */
const CURVE_KEYS = new Set(CURVE_KNOTS.map(curveParamKey));

/**
 * The point tone curve as ACR stores it: an rdf:Seq of "x, y" points, not an
 * attribute. Emitted for all four channels ACR expects, with RGB left linear —
 * the schema predicts the composite curve only.
 */
function curveElements(develop: Record<string, number>): string {
  const curve = curveFromDevelop(develop);
  if (!curve) return '';
  const points: string[] = [];
  for (let i = 0; i + 1 < curve.length; i += 2) points.push(`      <rdf:li>${curve[i]}, ${curve[i + 1]}</rdf:li>`);
  const seq = (tag: string, items: string[]): string =>
    `   <crs:${tag}>\n    <rdf:Seq>\n${items.join('\n')}\n    </rdf:Seq>\n   </crs:${tag}>`;
  const linear = ['      <rdf:li>0, 0</rdf:li>', '      <rdf:li>255, 255</rdf:li>'];
  return (
    '\n' +
    [
      seq('ToneCurvePV2012', points),
      seq('ToneCurvePV2012Red', linear),
      seq('ToneCurvePV2012Green', linear),
      seq('ToneCurvePV2012Blue', linear),
    ].join('\n')
  );
}

const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';

/** XML-escape an attribute value (profile names are user data — quotes happen). */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Re-indent a captured `<crs:Look>` element to sit inside rdf:Description.
 *
 * The element is replayed verbatim (see readLookXml) apart from whitespace: it
 * was lifted from a sidecar with its own indentation, and only the leading
 * columns are cosmetic.
 */
function indentLook(xml: string, pad: string): string {
  const lines = xml.split('\n');
  const base = Math.min(
    ...lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  );
  return lines.map((l) => (l.trim() ? pad + l.slice(base) : l)).join('\n');
}

/** Format a crs value: Exposure2012 keeps 2 signed decimals; the rest are ints. */
function formatValue(key: string, value: number): string {
  if (key === 'Exposure2012') {
    const v = Math.round(value * 100) / 100;
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  }
  return String(Math.round(value));
}

export function buildXmpSidecar(
  develop: Record<string, number>,
  treatment: Treatment,
  render?: PredictedEdit['render'],
): string {
  const attrs = Object.entries(develop)
    .filter(([k]) => !CURVE_KEYS.has(k))
    .map(([k, v]) => `    crs:${k}="${formatValue(k, v)}"`)
    .join('\n');
  const curve = curveElements(develop);
  // Without an explicit CameraProfile, Lightroom renders the file on its own
  // legacy default (Adobe Standard) — so a style learned on top of Adobe Color
  // arrives sitting on a different base, and every predicted slider is measured
  // against the wrong starting point. The Look is what actually carries the
  // modern profiles: "Adobe Color" is not a CameraProfile value, it is
  // "Adobe Standard v2" plus a Look element.
  const profileAttr = render?.profile ? `\n    crs:CameraProfile="${attr(render.profile)}"` : '';
  const lookElement = render?.lookXml ? `\n${indentLook(render.lookXml, '   ')}` : '';
  // The treatment is routing, not a predicted parameter, so it never appears in
  // the develop vector — but it has to be written or a B&W prediction lands as a
  // colour photo carrying a GrayMixer that does nothing. Emit it explicitly in
  // both directions so the sidecar is unambiguous about which look it encodes.
  const grayscale = treatment === 'bw';
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="${CRS_NS}"
    crs:Version="15.0"
    crs:ProcessVersion="11.0"
    crs:WhiteBalance="Custom"
    crs:ConvertToGrayscale="${grayscale ? 'True' : 'False'}"${profileAttr}
${attrs}>${curve}${lookElement}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}
