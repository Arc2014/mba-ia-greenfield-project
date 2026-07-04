import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-processing.constants';

/**
 * Consumes the `video-processing` queue in the dedicated worker process (per
 * phase-03 TD-04/TD-05): downloads the original, extracts duration/metadata and
 * a thumbnail with ffmpeg, persists them, and drives the lifecycle
 * `PROCESSING → READY | ERROR` (per phase-03 TD-08).
 */
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingConsumer extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId, originalKey } = job.data;
    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const originalPath = join(workDir, 'original');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      const source = await this.storage.getObjectStream(originalKey);
      await pipeline(source, createWriteStream(originalPath));

      const metadata = await this.ffmpeg.probe(originalPath);
      const frameAt =
        metadata.durationSeconds > 0
          ? Math.min(1, metadata.durationSeconds / 2)
          : 0;
      await this.ffmpeg.extractThumbnail(originalPath, thumbnailPath, frameAt);

      const thumbnailKey = `videos/${videoId}/thumbnail.jpg`;
      await this.storage.putObject(
        thumbnailKey,
        await readFile(thumbnailPath),
        'image/jpeg',
      );

      await this.videoRepository.update(
        { id: videoId },
        {
          status: VideoStatus.READY,
          duration_seconds: metadata.durationSeconds,
          width: metadata.width,
          height: metadata.height,
          thumbnail_key: thumbnailKey,
          failure_reason: null,
        },
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Runs after every failed attempt. Retries are left to BullMQ; only once the
   * attempts are exhausted do we mark the video `ERROR` and persist the reason.
   * This is a background handler — it logs and records state, never rethrows.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJobData>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    this.logger.error(
      `Processing exhausted ${maxAttempts} attempt(s) for video ${job.data.videoId}: ${job.failedReason}`,
    );
    await this.videoRepository.update(
      { id: job.data.videoId },
      {
        status: VideoStatus.ERROR,
        failure_reason: job.failedReason ?? 'Video processing failed',
      },
    );
  }
}
