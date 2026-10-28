import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api/client.js';
import type { JobRequest, JobStatus } from '../contract.js';

const POLL_MS = 500;

export interface JobHandle {
  job: JobStatus | undefined;
  error: string | undefined;
  running: boolean;
  start: (request: JobRequest) => Promise<JobStatus | undefined>;
  /** Follows a job started earlier, such as a training found running when the page opens. */
  follow: (status: JobStatus) => Promise<JobStatus | undefined>;
  cancel: () => void;
}

/** Starts one server job and follows it until it ends; resolves with the final status. */
export function useJob(): JobHandle {
  const [job, setJob] = useState<JobStatus>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      clearTimeout(timer.current);
    },
    [],
  );

  const follow = useCallback((initial: JobStatus) => {
    clearTimeout(timer.current);
    let status = initial;
    setJob(status);
    if (status.state !== 'running') return Promise.resolve<JobStatus | undefined>(status);
    return new Promise<JobStatus | undefined>((resolve) => {
      const poll = async () => {
        if (!mounted.current) return resolve(undefined);
        try {
          status = await api.job(status.id);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return resolve(undefined);
        }
        if (!mounted.current) return resolve(undefined);
        setJob(status);
        if (status.state === 'running') timer.current = setTimeout(poll, POLL_MS);
        else {
          if (status.state === 'failed') setError(status.error ?? 'The job failed.');
          resolve(status);
        }
      };
      timer.current = setTimeout(poll, POLL_MS);
    });
  }, []);

  const start = useCallback(
    async (request: JobRequest) => {
      setError(undefined);
      let status: JobStatus;
      try {
        status = await api.startJob(request);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      }
      return follow(status);
    },
    [follow],
  );

  const cancel = useCallback(() => {
    if (job?.state === 'running') void api.cancelJob(job.id).catch(() => {});
  }, [job]);

  return { job, error, running: job?.state === 'running', start, follow, cancel };
}
