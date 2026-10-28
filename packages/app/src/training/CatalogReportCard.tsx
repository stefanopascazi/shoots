/** @jsxImportSource preact */
import { Alert, Badge, Card } from '@shoots/ui';
import type { CatalogInspection } from '../contract.js';

/** What an export-only run found, for checking Lightroom's names against the engine's. */
export function CatalogReportCard({ report }: { report: CatalogInspection }) {
  return (
    <Card
      title="Catalog export check"
      description="Your develop settings as Lightroom returned them, compared with what training reads. Nothing was trained."
      actions={
        <Badge tone={report.missing.length === 0 ? 'success' : 'warning'}>
          {report.missing.length === 0 ? 'All names match' : `${report.missing.length} names not found`}
        </Badge>
      }
    >
      {!report.raw && (
        <Alert tone="warning" title="No raw settings">
          The plug-in sent only the filtered settings; update it to compare against what Lightroom returns.
        </Alert>
      )}
      <dl class="app-facts">
        <dt>Photos read</dt>
        <dd class="sh-num">{report.photos}</dd>
        <dt>With settings</dt>
        <dd class="sh-num">{report.withSettings}</dd>
        <dt>Edited</dt>
        <dd class="sh-num">
          {report.edited} ({report.bw} black and white)
        </dd>
        {Object.entries(report.shapes).map(([key, shape]) => (
          <>
            <dt>{key}</dt>
            <dd>
              <code>{shape}</code>
            </dd>
          </>
        ))}
        <dt>Saved to</dt>
        <dd>
          <code>{report.file}</code>
        </dd>
      </dl>
      <NameList title="Expected but never returned" names={report.missing} />
      <NameList title="Returned but not read" names={report.unknown} />
    </Card>
  );
}

function NameList({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <details class="app-training__names">
      <summary>
        {title} ({names.length})
      </summary>
      <p class="sh-muted">{names.join(', ')}</p>
    </details>
  );
}
