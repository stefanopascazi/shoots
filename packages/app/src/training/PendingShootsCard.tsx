/** @jsxImportSource preact */
import { Button, Card } from '@shoots/ui';
import type { PendingShoot } from '../contract.js';
import { folderName } from '../library/model.js';

/** Folders developed with shoots and not learned from yet, each one click from improving the profile. */
export function PendingShootsCard({
  shoots,
  disabled,
  onImprove,
}: {
  shoots: PendingShoot[];
  disabled: boolean;
  onImprove: (folder: string) => void;
}) {
  if (shoots.length === 0) return null;
  return (
    <Card
      title="Waiting to improve your profile"
      description="Developed with shoots and not learned from yet. Improve once you have finished them in Lightroom."
      flush
    >
      <table class="sh-table">
        <tbody>
          {shoots.map((s) => (
            <tr>
              <td>
                <div class="app-health__name">{folderName(s.folder)}</div>
                <code class="sh-muted app-pending__path">{s.folder}</code>
              </td>
              <td class="sh-num sh-muted">
                {s.pending} photo{s.pending === 1 ? '' : 's'} · {new Date(s.developedAt).toLocaleDateString()}
              </td>
              <td>
                <Button size="sm" icon="refresh" disabled={disabled} onClick={() => onImprove(s.folder)}>
                  Improve
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
