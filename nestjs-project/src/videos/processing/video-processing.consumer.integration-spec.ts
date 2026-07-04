import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getQueueToken } from '@nestjs/bullmq';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { cleanAllTables } from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from '../entities/video.entity';
import { StorageService } from '../storage/storage.service';
import { FfmpegService } from './ffmpeg.service';
import {
  VIDEO_PROCESSING_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './video-processing.constants';
import { VideoProcessingConsumer } from './video-processing.consumer';

const execFileAsync = promisify(execFile);

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function generateFixture(): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'consumer-fixture-'));
  const path = join(dir, 'fixture.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=1:size=160x120:rate=10',
    '-pix_fmt',
    'yuv420p',
    path,
  ]);
  const bytes = await readFile(path);
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

async function waitForStatus(
  repository: Repository<Video>,
  id: string,
  status: VideoStatus,
  timeoutMs = 25000,
): Promise<Video> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const video = await repository.findOneByOrFail({ id });
    if (video.status === status) {
      return video;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Video ${id} did not reach ${status} in ${timeoutMs}ms (last: ${video.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe('VideoProcessingConsumer (integration)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let queue: Queue<VideoProcessingJobData>;
  let counter = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, queueConfig, storageConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: dbConfig.host,
            port: dbConfig.port,
            username: dbConfig.username,
            password: dbConfig.password,
            database: dbConfig.name,
            entities: ALL_ENTITIES,
            synchronize: false,
          }),
        }),
        TypeOrmModule.forFeature(ALL_ENTITIES),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (config: ConfigType<typeof queueConfig>) => ({
            connection: { host: config.host, port: config.port },
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [StorageService, FfmpegService, VideoProcessingConsumer],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    dataSource = app.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = app.get(StorageService);
    queue = app.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  async function seedVideo(originalKey: string): Promise<Video> {
    counter += 1;
    const user = await dataSource.getRepository(User).save({
      email: `consumer_${counter}_${Date.now()}@example.com`,
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: `Channel ${counter}`,
      nickname: `consumer_chan_${counter}`,
      user_id: user.id,
    });
    return videoRepository.save({
      public_id: `pub_${counter}_${Date.now()}`,
      channel_id: channel.id,
      title: 'Processing me',
      status: VideoStatus.PROCESSING,
      original_key: originalKey,
      content_type: 'video/mp4',
    });
  }

  it('processes a job end-to-end and marks the video READY with metadata + thumbnail', async () => {
    const video = await seedVideo('placeholder');
    const originalKey = `videos/${video.id}/original.mp4`;
    await videoRepository.update(
      { id: video.id },
      { original_key: originalKey },
    );
    await storage.putObject(originalKey, await generateFixture(), 'video/mp4');

    await queue.add(VIDEO_PROCESSING_JOB, {
      videoId: video.id,
      originalKey,
    });

    const processed = await waitForStatus(
      videoRepository,
      video.id,
      VideoStatus.READY,
    );

    expect(processed.duration_seconds).toBe(1);
    expect(processed.width).toBe(160);
    expect(processed.height).toBe(120);
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);

    // The thumbnail object is really in storage.
    await expect(
      storage.getObjectStream(processed.thumbnail_key!),
    ).resolves.toBeDefined();
  });

  it('marks the video ERROR with a failure reason when attempts are exhausted', async () => {
    const video = await seedVideo('videos/missing/original.mp4');

    await queue.add(
      VIDEO_PROCESSING_JOB,
      { videoId: video.id, originalKey: 'videos/missing/original.mp4' },
      { attempts: 1, backoff: { type: 'fixed', delay: 100 } },
    );

    const failed = await waitForStatus(
      videoRepository,
      video.id,
      VideoStatus.ERROR,
    );

    expect(failed.failure_reason).toEqual(expect.any(String));
    expect(failed.failure_reason?.length).toBeGreaterThan(0);
  });
});
