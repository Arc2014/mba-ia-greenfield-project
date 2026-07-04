import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { User } from '../src/users/entities/user.entity';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { StorageService } from '../src/videos/storage/storage.service';

describe('videos-delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let seq = 0;

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
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function seedChannel(): Promise<Channel> {
    seq += 1;
    const user = await dataSource.getRepository(User).save({
      email: `viewer_${seq}_${Date.now()}@example.com`,
      password: 'hashed',
    });
    return dataSource.getRepository(Channel).save({
      name: `Channel ${seq}`,
      nickname: `viewer_chan_${seq}`,
      user_id: user.id,
    });
  }

  async function seedVideo(status: VideoStatus): Promise<Video> {
    seq += 1;
    const channel = await seedChannel();
    const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    const video = await videoRepository.save({
      id,
      public_id: `pub_${seq}_${Date.now()}`,
      channel_id: channel.id,
      title: 'A video',
      status,
      original_key: `videos/${id}/original.mp4`,
      content_type: 'video/mp4',
      ...(status === VideoStatus.READY && {
        duration_seconds: 42,
        width: 1280,
        height: 720,
        thumbnail_key: `videos/${id}/thumbnail.jpg`,
      }),
    });
    if (status === VideoStatus.READY) {
      // Real objects in MinIO so the presigned URLs point at existing keys.
      await storage.putObject(
        video.original_key,
        Buffer.from('fake-mp4'),
        'video/mp4',
      );
      await storage.putObject(
        video.thumbnail_key,
        Buffer.from('fake-jpg'),
        'image/jpeg',
      );
    }
    return video;
  }

  describe('GET /videos/:publicId', () => {
    it('returns metadata for a READY video to an anonymous caller', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('READY');
      expect(res.body.durationSeconds).toBe(42);
      expect(res.body.width).toBe(1280);
      expect(res.body.height).toBe(720);
      expect(res.body.thumbnailUrl).toEqual(expect.any(String));
      expect(res.body.viewsCount).toBe(0);
    });

    it('hides a non-READY video from an anonymous caller with 404', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer()).get(
        `/videos/${video.public_id}`,
      );

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:publicId/stream', () => {
    it('redirects (302) to a presigned URL and increments the view count', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(video.id);
      expect(res.headers.location).toContain('X-Amz-Signature');

      const after = await videoRepository.findOneByOrFail({ id: video.id });
      expect(after.views_count).toBe(1);
    });

    it('returns 409 VIDEO_NOT_READY for a non-READY video and does not count a view', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/stream`)
        .redirects(0);

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('VIDEO_NOT_READY');

      const after = await videoRepository.findOneByOrFail({ id: video.id });
      expect(after.views_count).toBe(0);
    });
  });

  describe('GET /videos/:publicId/download', () => {
    it('redirects (302) to a presigned URL forcing an attachment download', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toContain(
        'response-content-disposition=attachment',
      );
    });
  });
});
