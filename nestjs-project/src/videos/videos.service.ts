import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { nanoid } from 'nanoid';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  UnsupportedMediaTypeException,
  UploadAlreadyCompletedException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitUploadDto } from './dto/init-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './processing/video-processing.producer';
import { StorageService } from './storage/storage.service';
import {
  MAX_VIDEO_SIZE_BYTES,
  PUBLIC_ID_MAX_RETRIES,
  UPLOAD_PART_SIZE_BYTES,
  extensionForContentType,
  isVideoContentType,
} from './videos.constants';

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface InitUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
  uploadId: string;
  partSize: number;
  parts: PresignedPart[];
}

export interface CompleteUploadResult {
  id: string;
  publicId: string;
  status: VideoStatus;
}

export interface WatchInfo {
  publicId: string;
  title: string;
  status: VideoStatus;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  viewsCount: number;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly producer: VideoProcessingProducer,
  ) {}

  async initUpload(
    userId: string,
    dto: InitUploadDto,
  ): Promise<InitUploadResult> {
    if (dto.sizeBytes > MAX_VIDEO_SIZE_BYTES) {
      throw new FileTooLargeException();
    }
    if (!isVideoContentType(dto.contentType)) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Invariant: an authenticated user always has a channel (created at registration).
      throw new Error(`Authenticated user ${userId} has no channel`);
    }

    const id = randomUUID();
    const publicId = await this.generateUniquePublicId();
    const key = `videos/${id}/original.${extensionForContentType(dto.contentType)}`;

    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.contentType,
    );

    const partCount = Math.max(
      1,
      Math.ceil(dto.sizeBytes / UPLOAD_PART_SIZE_BYTES),
    );
    const parts: PresignedPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      parts.push({
        partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          uploadId,
          partNumber,
        ),
      });
    }

    await this.videoRepository.save(
      this.videoRepository.create({
        id,
        public_id: publicId,
        channel_id: channel.id,
        title: dto.title,
        status: VideoStatus.DRAFT,
        original_key: key,
        content_type: dto.contentType,
        size_bytes: dto.sizeBytes,
        upload_id: uploadId,
      }),
    );

    return {
      id,
      publicId,
      status: VideoStatus.DRAFT,
      uploadId,
      partSize: UPLOAD_PART_SIZE_BYTES,
      parts,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.channel.user_id !== userId) {
      throw new VideoNotOwnedException();
    }
    if (video.status !== VideoStatus.DRAFT) {
      throw new UploadAlreadyCompletedException();
    }

    await this.storageService.completeMultipartUpload(
      video.original_key!,
      video.upload_id!,
      dto.parts.map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
      })),
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    await this.videoRepository.save(video);

    await this.producer.enqueue(video.id, video.original_key!);

    return {
      id: video.id,
      publicId: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  /**
   * Public watch metadata. Anonymous callers (and non-owners) only see `READY`
   * videos; the owner sees any status so they can track processing (per TD-07).
   */
  async getWatchInfo(
    publicId: string,
    viewerUserId?: string,
  ): Promise<WatchInfo> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId },
      relations: ['channel'],
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const isOwner =
      viewerUserId !== undefined && video.channel.user_id === viewerUserId;
    if (video.status !== VideoStatus.READY && !isOwner) {
      // Non-ready videos are invisible to the public — 404, not a leak of existence.
      throw new VideoNotFoundException();
    }

    return {
      publicId: video.public_id,
      title: video.title,
      status: video.status,
      durationSeconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      thumbnailUrl: video.thumbnail_key
        ? await this.storageService.presignGet(video.thumbnail_key)
        : null,
      viewsCount: video.views_count,
    };
  }

  /**
   * Mints a short-lived presigned GET for streaming and counts the view. Storage
   * serves Range/206 natively, so the bytes never transit the API (per TD-07).
   */
  async getStreamRedirect(publicId: string): Promise<string> {
    const video = await this.findReadyVideoOrThrow(publicId);
    const url = await this.storageService.presignGet(video.original_key!);
    await this.videoRepository.increment({ id: video.id }, 'views_count', 1);
    return url;
  }

  /** Presigned GET forcing an attachment download (per TD-07). */
  async getDownloadRedirect(publicId: string): Promise<string> {
    const video = await this.findReadyVideoOrThrow(publicId);
    return this.storageService.presignGet(video.original_key!, {
      contentDisposition: 'attachment',
    });
  }

  private async findReadyVideoOrThrow(publicId: string): Promise<Video> {
    const video = await this.videoRepository.findOneBy({ public_id: publicId });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async generateUniquePublicId(): Promise<string> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_RETRIES; attempt++) {
      const candidate = nanoid();
      const existing = await this.videoRepository.findOneBy({
        public_id: candidate,
      });
      if (!existing) {
        return candidate;
      }
    }
    throw new Error('Could not generate a unique public_id');
  }
}
