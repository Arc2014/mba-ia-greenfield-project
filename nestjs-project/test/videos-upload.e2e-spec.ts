import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/processing/video-processing.constants';

interface AuthedUser {
  accessToken: string;
  userId: string;
  channelId: string;
}

describe('videos-upload (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;
  let userSeq = 0;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true });
  });

  async function registerConfirmAndLogin(): Promise<AuthedUser> {
    const email = `uploader_${++userSeq}_${Date.now()}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let confirmationToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        confirmationToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    const user = await dataSource
      .getRepository(User)
      .findOneByOrFail({ email });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: user.id });

    return {
      accessToken: loginRes.body.access_token as string,
      userId: user.id,
      channelId: channel.id,
    };
  }

  /** Init + upload a single small part; returns the video id + part ETag. */
  async function initAndUploadOnePart(
    auth: AuthedUser,
  ): Promise<{ videoId: string; etag: string }> {
    const initRes = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({ title: 'Clip', contentType: 'video/mp4', sizeBytes: 104857600 });

    const { id, parts } = initRes.body as {
      id: string;
      parts: { partNumber: number; url: string }[];
    };
    const putRes = await fetch(parts[0].url, {
      method: 'PUT',
      body: Buffer.from('tiny-video-bytes'),
    });
    const etag = putRes.headers.get('etag');
    return { videoId: id, etag: etag! };
  }

  describe('POST /videos', () => {
    it('initiates an upload and pre-registers a DRAFT video', async () => {
      const auth = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({
          title: 'My clip',
          contentType: 'video/mp4',
          sizeBytes: 104857600,
        });

      expect(res.status).toBe(201);
      expect(res.body.publicId).toEqual(expect.any(String));
      expect(res.body.uploadId).toEqual(expect.any(String));
      expect(res.body.partSize).toEqual(expect.any(Number));
      expect(Array.isArray(res.body.parts)).toBe(true);
      expect(res.body.parts[0]).toMatchObject({
        partNumber: 1,
        url: expect.any(String),
      });

      const video = await videoRepository.findOneByOrFail({
        public_id: res.body.publicId,
      });
      expect(video.status).toBe(VideoStatus.DRAFT);
      expect(video.channel_id).toBe(auth.channelId);
    });

    it('rejects files larger than 10GB with 413 FILE_TOO_LARGE', async () => {
      const auth = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({
          title: 'Too big',
          contentType: 'video/mp4',
          sizeBytes: 11 * 1024 ** 3,
        });

      expect(res.status).toBe(413);
      expect(res.body.error).toBe('FILE_TOO_LARGE');
      await expect(videoRepository.count()).resolves.toBe(0);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app.getHttpServer()).post('/videos').send({
        title: 'No auth',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      });

      expect(res.status).toBe(401);
      await expect(videoRepository.count()).resolves.toBe(0);
    });
  });

  describe('POST /videos/:id/complete', () => {
    it('completes the upload, transitions to PROCESSING and enqueues the job', async () => {
      const auth = await registerConfirmAndLogin();
      const { videoId, etag } = await initAndUploadOnePart(auth);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PROCESSING');

      const video = await videoRepository.findOneByOrFail({ id: videoId });
      expect(video.status).toBe(VideoStatus.PROCESSING);

      const waiting = await queue.getWaiting();
      expect(waiting.map((job) => job.data.videoId)).toContain(videoId);
    });

    it('rejects completion by a non-owner with 403 VIDEO_NOT_OWNED', async () => {
      const owner = await registerConfirmAndLogin();
      const intruder = await registerConfirmAndLogin();
      const { videoId } = await initAndUploadOnePart(owner);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${intruder.accessToken}`)
        .send({ parts: [{ partNumber: 1, etag: '"whatever"' }] });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('VIDEO_NOT_OWNED');

      const video = await videoRepository.findOneByOrFail({ id: videoId });
      expect(video.status).toBe(VideoStatus.DRAFT);
    });

    it('rejects completion of a non-DRAFT video with 409 UPLOAD_ALREADY_COMPLETED', async () => {
      const auth = await registerConfirmAndLogin();
      const { videoId, etag } = await initAndUploadOnePart(auth);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete`)
        .set('Authorization', `Bearer ${auth.accessToken}`)
        .send({ parts: [{ partNumber: 1, etag }] });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('UPLOAD_ALREADY_COMPLETED');
    });
  });
});
