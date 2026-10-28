/** @jsxImportSource preact */
import { Button, Card, Progress } from '@shoots/ui';
import type { JobStatus } from '../contract.js';

const TITLE: Record<JobStatus['kind'], string> = {
  cull: 'Finding blurry photos',
  rate: 'Rating photos',
  doctor: 'Checking the setup',
  train: 'Learning your style',
  calibrate: 'Calibrating',
};

/** The running job: what it is doing now and a way to stop it. */
export function JobPanel({ job, onCancel }: { job: JobStatus; onCancel: () => void }) {
  const p = job.progress;
  const fraction = p?.total ? (p.done ?? 0) / p.total : undefined;
  const label = p ? (p.total ? `${p.label} · ${p.done ?? 0} of ${p.total}` : p.label) : 'Starting…';
  return (
    <Card class="app-job">
      <div class="app-job__row">
        <div class="app-job__text">
          <strong>{TITLE[job.kind]}</strong>
          <span class="sh-muted">{p?.detail ?? 'Nothing is written to your photos or catalog.'}</span>
        </div>
        <Button size="sm" variant="ghost" icon="stop" onClick={onCancel}>
          Stop
        </Button>
      </div>
      <Progress value={fraction} label={label} />
    </Card>
  );
}
