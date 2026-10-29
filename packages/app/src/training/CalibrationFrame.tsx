/** @jsxImportSource preact */

/**
 * The calibration page, embedded. It stays the CLI's own page — served by
 * `develop calibrate --review`, usable without the app — and the app only
 * frames it, so a subscriber never juggles a second tab.
 */
export function CalibrationFrame({ url }: { url: string }) {
  return <iframe class="app-calibration" src={url} title="Calibrate your profile" />;
}
