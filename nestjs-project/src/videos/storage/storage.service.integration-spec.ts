import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../../config/storage.config';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();
    service = moduleRef.get(StorageService);
  });

  it('round-trips a multipart upload via presigned URLs and reads it back', async () => {
    const key = `test/${Date.now()}-roundtrip.bin`;
    const payload = 'hello multipart world';

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(uploadId).toBeTruthy();

    const partUrl = await service.presignUploadPart(key, uploadId, 1);
    const putResponse = await fetch(partUrl, {
      method: 'PUT',
      body: Buffer.from(payload),
    });
    expect(putResponse.ok).toBe(true);
    const etag = putResponse.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { PartNumber: 1, ETag: etag! },
    ]);

    const getUrl = await service.presignGet(key);
    const getResponse = await fetch(getUrl);
    expect(getResponse.status).toBe(200);
    await expect(getResponse.text()).resolves.toBe(payload);
  });

  it('presignGet honors contentDisposition for downloads', async () => {
    const url = await service.presignGet('any/key.mp4', {
      contentDisposition: 'attachment',
    });
    expect(url).toContain('response-content-disposition=attachment');
  });

  it('abortMultipartUpload discards an incomplete upload', async () => {
    const key = `test/${Date.now()}-abort.bin`;
    const uploadId = await service.createMultipartUpload(key);

    await service.abortMultipartUpload(key, uploadId);

    // Completing an aborted upload must fail — the upload no longer exists.
    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { PartNumber: 1, ETag: '"deadbeef"' },
      ]),
    ).rejects.toThrow();
  });
});
