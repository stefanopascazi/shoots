/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Alert, Badge, Button, Card, PageHeader, Spinner, type Tone } from '@shoots/ui';
import type { AppInfo, CheckStatus, DoctorReport } from '../contract.js';
import { useJob } from '../hooks/useJob.js';
import type { SettingsHandle } from '../hooks/useSettings.js';
import { PreferencesCard } from './PreferencesCard.js';

const TONE: Record<CheckStatus, Tone> = { ok: 'success', warn: 'warning', fail: 'danger' };
const LABEL: Record<CheckStatus, string> = { ok: 'OK', warn: 'Warning', fail: 'Failed' };

/** Preferences, what `shoots doctor` finds, and where shoots keeps its data. */
export function HealthScreen({ info, prefs }: { info: AppInfo | undefined; prefs: SettingsHandle }) {
  const job = useJob();
  const [report, setReport] = useState<DoctorReport>();

  const check = async () => {
    const done = await job.start({ kind: 'doctor' });
    if (done?.state === 'done') setReport(done.result as DoctorReport);
  };

  useEffect(() => {
    void check();
  }, []);

  return (
    <>
      <PageHeader
        title="Setup"
        description="Your preferences, and the tools shoots relies on, checked on this computer."
        actions={
          <Button icon="refresh" onClick={check} loading={job.running}>
            Check again
          </Button>
        }
      />
      {job.error && <Alert tone="danger" title="The check did not run">{job.error}</Alert>}
      {report && report.summary.failed > 0 && (
        <Alert tone="warning" title={`${report.summary.failed} check${report.summary.failed === 1 ? '' : 's'} failed`}>
          Download them from the plug-in: Library › Plug-in Extras › Download Dependencies.
        </Alert>
      )}
      <div class="app-health">
        <Card title="Checks" flush>
          {report ? (
            <table class="sh-table">
              <tbody>
                {report.checks.map((c) => (
                  <tr>
                    <td class="app-health__name">{c.name}</td>
                    <td>
                      <Badge tone={TONE[c.status]}>{LABEL[c.status]}</Badge>
                    </td>
                    <td class="sh-muted app-health__detail">{c.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="app-center">
              <Spinner size={20} label="Checking" />
            </div>
          )}
        </Card>
        <div class="app-side">
        <PreferencesCard prefs={prefs} />
        <Card title="This installation">
          <dl class="app-facts">
            <dt>Version</dt>
            <dd class="sh-num">{info?.version ?? '—'}</dd>
            <dt>Platform</dt>
            <dd>{info?.platform ?? '—'}</dd>
            <dt>Data folder</dt>
            <dd>
              <code>{info?.home ?? '—'}</code>
            </dd>
          </dl>
        </Card>
        </div>
      </div>
    </>
  );
}
