import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  VIDEO_PROCESSING_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<VideoProcessingJobData>,
  ) {}

  async enqueue(videoId: string, originalKey: string): Promise<void> {
    await this.queue.add(VIDEO_PROCESSING_JOB, { videoId, originalKey });
  }
}
