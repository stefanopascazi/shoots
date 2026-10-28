/** @jsxImportSource preact */
import { Button, Card, Icon, Progress, buttonClass } from '@shoots/ui';
import type { JobStatus } from '../contract.js';
import { stepLabel } from './model.js';

const TITLE: Partial<Record<JobStatus['kind'], string>> = {
  train: 'Learning your style',
  calibrate: 'Calibrating',
};

/** A running training or calibration: where it is, the review page when it waits on one, a way to stop it. */
export function TrainingJobCard({ job, onCancel }: { job: JobStatus; onCancel: () => void }) {
  const p = job.progress;
  const fraction = p?.total ? (p.done ?? 0) / p.total : undefined;
  return (
    <Card class="app-job">
      <div class="app-job__row">
        <div class="app-job__text">
          <strong>{TITLE[job.kind] ?? 'Working'}</strong>
          <span class="sh-muted">
            {p?.detail ?? 'It runs on this computer and carries on if Lightroom closes. Open shoots again to see where it is.'}
          </span>
        </div>
        {p?.url && (
          <a class={buttonClass('primary', 'sm')} href={p.url} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={14} />
            Open the calibration page
          </a>
        )}
        <Button size="sm" variant="ghost" icon="stop" onClick={onCancel}>
          Stop
        </Button>
      </div>
      <Progress value={fraction} label={stepLabel(job)} />
    </Card>
  );
}
