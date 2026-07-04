import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../../config/queue.config';
import {
  VIDEO_PROCESSING_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let moduleRef: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (config: ConfigType<typeof queueConfig>) => ({
            connection: { host: config.host, port: config.port },
          }),
        }),
        BullModule.registerQueue({
          name: VIDEO_PROCESSING_QUEUE,
          defaultJobOptions: VIDEO_PROCESSING_JOB_OPTIONS,
        }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = moduleRef.get(VideoProcessingProducer);
    queue = moduleRef.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('enqueues a job carrying videoId and originalKey', async () => {
    await producer.enqueue('vid-1', 'videos/vid-1/original.mp4');

    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);
    expect(waiting[0].data).toEqual({
      videoId: 'vid-1',
      originalKey: 'videos/vid-1/original.mp4',
    });
  });

  it('applies attempts=3 and exponential backoff to enqueued jobs', async () => {
    await producer.enqueue('vid-2', 'videos/vid-2/original.mp4');

    const [job] = await queue.getWaiting();
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toMatchObject({ type: 'exponential' });
  });
});
