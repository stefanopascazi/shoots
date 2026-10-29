/** @jsxImportSource preact */
import { Spinner } from '@shoots/ui';
import { exifRows } from './exifRows.js';
import { useExif } from './useExif.js';

/** Camera, lens, exposure and the rest of what the camera recorded. */
export function ExifFacts({ path }: { path: string }) {
  const exif = useExif(path);
  return (
    <section class="app-exif">
      <div class="sh-eyebrow">Capture</div>
      {exif.state === 'loading' ? (
        <Spinner size={16} label="Reading capture data" />
      ) : exif.state === 'failed' ? (
        <p class="sh-subtle app-note">{exif.error}</p>
      ) : (
        <ExifList rows={exifRows(exif.exif)} />
      )}
    </section>
  );
}

export function ExifList({ rows }: { rows: { label: string; value: string }[] }) {
  if (rows.length === 0) return <p class="sh-subtle app-note">The camera recorded no capture data.</p>;
  return (
    <dl class="app-facts">
      {rows.map((r) => (
        <>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
        </>
      ))}
    </dl>
  );
}
