import { JOB_CLASSES } from './types.ts';
import type { Job } from './types.ts';

/** Argument checks shared by the doubles, so both reject the same malformed input the same way. */
export function assertJob(job: Job): void {
  if (!JOB_CLASSES.includes(job.class)) {
    throw new RangeError(`Unknown job class: ${String(job.class)}`);
  }
  if (job.timeoutMs !== undefined && !(Number.isFinite(job.timeoutMs) && job.timeoutMs >= 0)) {
    throw new RangeError('timeoutMs must be a finite number >= 0');
  }
}

export function assertEstimatedBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError('estimatedBytes must be a non-negative integer');
  }
}
