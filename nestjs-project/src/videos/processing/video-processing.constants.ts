import type { DefaultJobOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_PROCESSING_JOB = 'process';

export interface VideoProcessingJobData {
  videoId: string;
  originalKey: string;
}

/**
 * Retry/backoff defaults for the processing queue (per phase-03 TD-01 + TD-08):
 * 3 attempts with exponential backoff. Shared by the queue registration and the
 * integration test so there is a single source of truth.
 */
export const VIDEO_PROCESSING_JOB_OPTIONS: DefaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: true,
  removeOnFail: 1000,
};
