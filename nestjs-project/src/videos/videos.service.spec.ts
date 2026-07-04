import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './processing/video-processing.producer';
import { StorageService } from './storage/storage.service';
import { VideosService } from './videos.service';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: {
    findOneBy: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    increment: jest.Mock;
  };
  let channelsService: { findByUserId: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    completeMultipartUpload: jest.Mock;
    presignGet: jest.Mock;
  };
  let producer: { enqueue: jest.Mock };

  beforeEach(async () => {
    videoRepository = {
      findOneBy: jest.fn().mockResolvedValue(null),
      findOne: jest.fn(),
      create: jest.fn((value: unknown) => value),
      save: jest.fn((value: unknown) => Promise.resolve(value)),
      increment: jest.fn().mockResolvedValue(undefined),
    };
    channelsService = {
      findByUserId: jest
        .fn()
        .mockResolvedValue({ id: 'chan-1', user_id: 'user-1' }),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      presignUploadPart: jest.fn().mockResolvedValue('https://signed/part'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignGet: jest.fn().mockResolvedValue('https://signed/get'),
    };
    producer = { enqueue: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingProducer, useValue: producer },
      ],
    }).compile();

    service = moduleRef.get(VideosService);
  });

  describe('initUpload', () => {
    const dto = {
      title: 'My video',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    };

    it('creates a DRAFT video and returns presigned parts', async () => {
      const result = await service.initUpload('user-1', dto);

      expect(result.status).toBe(VideoStatus.DRAFT);
      expect(result.uploadId).toBe('upload-1');
      expect(result.parts.length).toBeGreaterThanOrEqual(1);
      expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(1);
      expect(videoRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: VideoStatus.DRAFT,
          channel_id: 'chan-1',
          title: 'My video',
        }),
      );
    });

    it('regenerates public_id on collision', async () => {
      videoRepository.findOneBy
        .mockResolvedValueOnce({ id: 'existing' })
        .mockResolvedValueOnce(null);

      await service.initUpload('user-1', dto);

      expect(videoRepository.findOneBy).toHaveBeenCalledTimes(2);
    });

    it('rejects files larger than 10GB', async () => {
      await expect(
        service.initUpload('user-1', { ...dto, sizeBytes: 11 * 1024 ** 3 }),
      ).rejects.toBeInstanceOf(FileTooLargeException);
    });

    it('rejects non-video content types', async () => {
      await expect(
        service.initUpload('user-1', { ...dto, contentType: 'image/png' }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });
  });

  describe('completeUpload', () => {
    const draftVideo = () => ({
      id: 'vid-1',
      public_id: 'pub-1',
      status: VideoStatus.DRAFT,
      original_key: 'videos/vid-1/original.mp4',
      upload_id: 'upload-1',
      channel: { user_id: 'user-1' },
    });
    const parts = { parts: [{ partNumber: 1, etag: '"etag"' }] };

    it('transitions DRAFT to PROCESSING and enqueues processing', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      const result = await service.completeUpload('user-1', 'vid-1', parts);

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storageService.completeMultipartUpload).toHaveBeenCalledTimes(1);
      expect(producer.enqueue).toHaveBeenCalledWith(
        'vid-1',
        'videos/vid-1/original.mp4',
      );
    });

    it('throws when the video does not exist', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-1', 'vid-x', parts),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws when the caller does not own the video', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...draftVideo(),
        channel: { user_id: 'someone-else' },
      });

      await expect(
        service.completeUpload('user-1', 'vid-1', parts),
      ).rejects.toBeInstanceOf(VideoNotOwnedException);
    });

    it('throws when the video is not in DRAFT', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...draftVideo(),
        status: VideoStatus.PROCESSING,
      });

      await expect(
        service.completeUpload('user-1', 'vid-1', parts),
      ).rejects.toBeInstanceOf(UploadAlreadyCompletedException);
    });
  });

  describe('delivery', () => {
    const readyVideo = () => ({
      id: 'vid-1',
      public_id: 'pub-1',
      title: 'Ready clip',
      status: VideoStatus.READY,
      original_key: 'videos/vid-1/original.mp4',
      thumbnail_key: 'videos/vid-1/thumbnail.jpg',
      duration_seconds: 42,
      width: 1920,
      height: 1080,
      views_count: 7,
      channel: { user_id: 'owner-1' },
    });

    it('returns watch info with a presigned thumbnail URL for a READY video', async () => {
      videoRepository.findOne.mockResolvedValue(readyVideo());

      const info = await service.getWatchInfo('pub-1');

      expect(info.status).toBe(VideoStatus.READY);
      expect(info.viewsCount).toBe(7);
      expect(info.thumbnailUrl).toBe('https://signed/get');
    });

    it('hides a non-READY video from an anonymous viewer', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...readyVideo(),
        status: VideoStatus.PROCESSING,
      });

      await expect(service.getWatchInfo('pub-1')).rejects.toBeInstanceOf(
        VideoNotFoundException,
      );
    });

    it('reveals a non-READY video to its owner', async () => {
      videoRepository.findOne.mockResolvedValue({
        ...readyVideo(),
        status: VideoStatus.PROCESSING,
      });

      const info = await service.getWatchInfo('pub-1', 'owner-1');

      expect(info.status).toBe(VideoStatus.PROCESSING);
    });

    it('increments views_count when emitting a stream URL', async () => {
      videoRepository.findOneBy.mockResolvedValue(readyVideo());

      const url = await service.getStreamRedirect('pub-1');

      expect(url).toBe('https://signed/get');
      expect(videoRepository.increment).toHaveBeenCalledWith(
        { id: 'vid-1' },
        'views_count',
        1,
      );
    });

    it('throws VideoNotReady when streaming a non-READY video', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        ...readyVideo(),
        status: VideoStatus.PROCESSING,
      });

      await expect(service.getStreamRedirect('pub-1')).rejects.toBeInstanceOf(
        VideoNotReadyException,
      );
      expect(videoRepository.increment).not.toHaveBeenCalled();
    });

    it('presigns a download URL with attachment disposition', async () => {
      videoRepository.findOneBy.mockResolvedValue(readyVideo());

      await service.getDownloadRedirect('pub-1');

      expect(storageService.presignGet).toHaveBeenCalledWith(
        'videos/vid-1/original.mp4',
        { contentDisposition: 'attachment' },
      );
    });
  });
});
