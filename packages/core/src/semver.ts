/**
 * Minimal SemVer comparison — just enough to decide whether a release is newer
 * than the running build. Compares major.minor.patch numerically; an optional
 * leading `v` and any `-prerelease`/`+build` suffix are ignored.
 */
function parse(version: string): [number, number, number] {
  const core = version.trim().replace(/^v/i, '').split(/[-+]/, 1)[0];
  const [a, b, c] = core.split('.').map((n) => parseInt(n, 10) || 0);
  return [a ?? 0, b ?? 0, c ?? 0];
}

/** Returns >0 if a>b, <0 if a<b, 0 if equal (on the x.y.z core). */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
