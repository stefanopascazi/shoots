/**
 * Minimal XMP sidecar writer for predicted develop settings.
 *
 * A Lightroom-readable `.xmp` is just an RDF wrapper with crs: attributes, so we
 * template it directly — no exiftool needed on the tool side. This lets a
 * prediction be dropped next to a RAW and read by Lightroom as a starting point,
 * before the Lua plugin (Fase 4) wires proper preset application via the SDK.
 */

const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';

/** Format a crs value: Exposure2012 keeps 2 signed decimals; the rest are ints. */
function formatValue(key: string, value: number): string {
  if (key === 'Exposure2012') {
    const v = Math.round(value * 100) / 100;
    return `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  }
  return String(Math.round(value));
}

export function buildXmpSidecar(develop: Record<string, number>): string {
  const attrs = Object.entries(develop)
    .map(([k, v]) => `    crs:${k}="${formatValue(k, v)}"`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="${CRS_NS}"
    crs:Version="15.0"
    crs:ProcessVersion="11.0"
    crs:WhiteBalance="Custom"
${attrs}>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}
