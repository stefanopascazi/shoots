/**
 * Canonical develop edit → an Adobe Camera Raw sidecar.
 *
 * A Lightroom-readable `.xmp` is just an RDF wrapper around crs: attributes, so
 * we template it directly — no exiftool needed on the write side. Dropping one
 * next to a RAW gives the photographer a non-destructive starting point they can
 * accept or discard.
 */

import type { Treatment } from '../../develop/schema.js';

const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';

/** Format a crs value: Exposure2012 keeps 2 signed decimals; the rest are ints. */
function formatValue(key: string, value: number): string {
  if (key === 'Exposure2012') {
    const v = Math.round(value * 100) / 100;
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  }
  return String(Math.round(value));
}

export function buildXmpSidecar(develop: Record<string, number>, treatment: Treatment): string {
  const attrs = Object.entries(develop)
    .map(([k, v]) => `    crs:${k}="${formatValue(k, v)}"`)
    .join('\n');
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
    crs:ConvertToGrayscale="${grayscale ? 'True' : 'False'}"
${attrs}>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}
