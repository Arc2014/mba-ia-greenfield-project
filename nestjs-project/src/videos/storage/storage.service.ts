import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../../config/storage.config';

const DEFAULT_EXPIRES_IN_SECONDS = 3600;

export interface UploadedPart {
  PartNumber: number;
  ETag: string;
}

export interface PresignGetOptions {
  expiresIn?: number;
  /** Sets `response-content-disposition` on the presigned GET (e.g. `attachment`). */
  contentDisposition?: string;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private bucketReady?: Promise<void>;

  constructor(
    @Inject(storageConfig.KEY)
    config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Creates the bucket on first use if it does not exist. Memoized so the check
   * runs once per process; keeps app boot decoupled from the storage backend.
   */
  private async ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        try {
          await this.client.send(
            new HeadBucketCommand({ Bucket: this.bucket }),
          );
        } catch {
          await this.client.send(
            new CreateBucketCommand({ Bucket: this.bucket }),
          );
        }
      })();
    }
    return this.bucketReady;
  }

  async createMultipartUpload(
    key: string,
    contentType?: string,
  ): Promise<string> {
    await this.ensureBucket();
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error('S3 did not return an UploadId for the multipart upload');
    }
    return result.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn = DEFAULT_EXPIRES_IN_SECONDS,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  /**
   * Streams an object's body from storage. Used by the worker to pull the
   * original video to a temp file for ffmpeg without buffering 10GB in memory.
   */
  async getObjectStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) {
      throw new Error(`Storage object ${key} has no body`);
    }
    return result.Body as Readable;
  }

  /** Uploads an object in a single request (worker thumbnail upload). */
  async putObject(
    key: string,
    body: Buffer,
    contentType?: string,
  ): Promise<void> {
    await this.ensureBucket();
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGet(
    key: string,
    options: PresignGetOptions = {},
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS },
    );
  }
}
