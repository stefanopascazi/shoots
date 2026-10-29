import { useCallback, useEffect, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { DevelopStatus, JobRequest, PendingShoot } from '../contract.js';
import { useJob, type JobHandle } from '../hooks/useJob.js';

export interface TrainingHandle {
  job: JobHandle;
  status: DevelopStatus | undefined;
  /** Folders developed with shoots that the profile has not learned from yet. */
  pending: PendingShoot[];
  /** Starts a training or calibration and refreshes the profile when it ends. */
  run: (request: JobRequest) => Promise<void>;
}

/**
 * The training screen's state. A training started before the app last stopped
 * is still running, or has finished meanwhile: it is picked up on open.
 */
export function useTraining(): TrainingHandle {
  const job = useJob();
  const [status, setStatus] = useState<DevelopStatus>();
  const [pending, setPending] = useState<PendingShoot[]>([]);

  const refresh = useCallback(() => {
    api.developStatus().then(setStatus, () => {});
    api.pendingShoots().then(setPending, () => {});
  }, []);

  useEffect(() => {
    refresh();
    api.trainingJob().then(
      async ({ job: latest }) => {
        if (!latest) return;
        await job.follow(latest);
        refresh();
      },
      () => {},
    );
  }, []);

  const run = useCallback(
    async (request: JobRequest) => {
      await job.start(request);
      refresh();
    },
    [job.start, refresh],
  );

  return { job, status, pending, run };
}
