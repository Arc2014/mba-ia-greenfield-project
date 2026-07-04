---
libs:
  "bullmq":
    version: "^5.79.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-06-30T09:31:02-03:00"
  "@nestjs/bullmq":
    version: "^11.0.4"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-06-30T09:31:02-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1076.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-30T09:31:02-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1076.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-30T09:31:02-03:00"
  "nanoid":
    version: "^5.1.16"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-06-30T09:31:02-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-30T09:30:32-03:00"
---

# phase-03-videos — Library References

Context7-sourced docs cache for the new libraries decided in Phase 03. Distilled to the
surfaces this phase actually uses (queue/worker, S3 presigning, short IDs). Consumed by
`/plan-build` and `/implement`. Versions pinned from the npm registry on 2026-06-30.

> **Docker note:** every Redis/MinIO host below is a Compose **service name** (e.g. `redis`,
> `minio`), never `localhost` — per CLAUDE.md Docker networking rule.

---

## bullmq (`^5.79.2`)

Redis-backed queue + worker. Covers **TD-01** (queue tech) and **TD-08** (retry/backoff on
processing failure). The worker runs in a **separate Compose service** (TD-04), so `Queue`
(API side, enqueues) and `Worker` (worker side, consumes) are instantiated in different
processes against the **same** Redis.

**Connection.** Pass a plain `connection` object (host/port) — BullMQ creates the ioredis
client internally. A standalone `Worker` connection should set `maxRetriesPerRequest: null`.

```typescript
import { Queue, Worker } from 'bullmq';

// API process — enqueue side
const videoQueue = new Queue('video-processing', {
  connection: { host: 'redis', port: 6379 }, // Compose service name
});

// Worker process — consume side (separate container, TD-04)
const worker = new Worker(
  'video-processing',
  async job => {
    // job.data = { videoId, key }
    await job.updateProgress(10);
    // ...ffmpeg/ffprobe work (TD-05)...
    return { duration, thumbnailKey };
  },
  { connection: { host: 'redis', port: 6379 }, concurrency: 2 },
);
```

**Retry / backoff (TD-08).** Set per-job when enqueuing (or via `defaultJobOptions` on the
Queue). Exponential backoff is the canonical choice for transcode retries:

```typescript
await videoQueue.add(
  'process',
  { videoId, key },
  {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }, // 1s, 2s, 4s
    removeOnComplete: true,    // keep Redis lean
    removeOnFail: 1000,        // retain recent failures for inspection
  },
);
```

**Failure handling (TD-08 → ERROR state).** The `failed` event fires after the **last**
attempt is exhausted. `job.attemptsMade` and `job.failedReason` give the persistence inputs
for the `ERROR` status + failure reason. Re-enqueue (`queue.add` again, or `job.retry()`)
implements the "re-enqueue to reprocess" decision.

```typescript
worker.on('failed', (job, err) => {
  // persist video.status = ERROR, video.failureReason = err.message
});
worker.on('completed', (job, result) => {
  // persist video.status = READY, duration, thumbnailKey
});
```

> **Gotcha:** the `bull/quick-guide.md` snippet (`require('bull')`, `videoQueue.process(...)`,
> `job.progress(42)`) is **legacy Bull v3**, NOT BullMQ. Ignore it — BullMQ uses the
> `new Worker(name, processor, opts)` form and `job.updateProgress()`.

---

## @nestjs/bullmq (`^11.0.4`)

NestJS wrapper over BullMQ (matches Nest 11). Covers the **DI/wiring** for TD-01 on both the
API and the worker. **Distinct from `@nestjs/bull`** (legacy Bull): `@nestjs/bullmq` uses the
`@Processor` **class** decorator + `WorkerHost` abstract class, not the `@Process` method
decorator.

**Root + queue registration (use the Async forms to pull Redis from `ConfigService`).**

```typescript
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        connection: {
          host: cfg.getOrThrow<string>('REDIS_HOST'), // 'redis'
          port: cfg.getOrThrow<number>('REDIS_PORT'),
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'video-processing',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    }),
  ],
})
export class VideoQueueModule {}
```

**Enqueue side (API) — inject the queue.**

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class VideoProcessingProducer {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}

  enqueue(videoId: string, key: string) {
    return this.queue.add('process', { videoId, key }); // BullMQ sig: add(name, data)
  }
}
```

**Consume side (worker) — `@Processor` + `WorkerHost`.**

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoProcessingConsumer extends WorkerHost {
  async process(job: Job): Promise<{ duration: number; thumbnailKey: string }> {
    // job.data = { videoId, key }; run ffprobe/ffmpeg (TD-05)
    return { duration, thumbnailKey };
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) { /* status = READY */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job) { /* status = ERROR, failureReason = job.failedReason */ }
}
```

> Worker concurrency is passed as the second arg to `@Processor`, e.g.
> `@Processor('video-processing', { concurrency: 2 })`.

---

## @aws-sdk/client-s3 (`^3.1076.0`)

S3 client. Covers **TD-02** (storage access), **TD-03** (multipart upload), **TD-07**
(delivery). Talks to **MinIO** in dev via a custom endpoint; the same code points at AWS S3
in prod by swapping env (TD-02's swap-is-config goal).

**Client config for MinIO (path-style is required).**

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  endpoint: cfg.getOrThrow('S3_ENDPOINT'),   // e.g. http://minio:9000 (Compose service)
  region: cfg.get('S3_REGION') ?? 'us-east-1',
  forcePathStyle: true,                       // MANDATORY for MinIO (no DNS vhost buckets)
  credentials: {
    accessKeyId: cfg.getOrThrow('S3_ACCESS_KEY'),
    secretAccessKey: cfg.getOrThrow('S3_SECRET_KEY'),
  },
});
```

**Multipart upload commands (TD-03 — API orchestrates, bytes never transit the API).**
The API issues these control-plane commands; the **client PUTs each part directly** to a
presigned URL (see s3-request-presigner below).

- `CreateMultipartUploadCommand` → returns `UploadId` (at upload *init*; draft row created here).
- `UploadPartCommand` → presigned, one per part (`PartNumber` 1..N, `UploadId`). Client PUTs
  the bytes and reads the `ETag` response header per part.
- `CompleteMultipartUploadCommand` → body lists `{ ETag, PartNumber }` for every part
  (at *complete*; processing enqueued here, TD-08).
- `AbortMultipartUploadCommand` → cleanup for incomplete uploads (pair with an S3/MinIO
  lifecycle rule to reap orphaned parts).

```typescript
import {
  CreateMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3';

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
  Bucket: 'videos',
  Key: `videos/${videoId}/original.${ext}`,
  ContentType: mime,
}));

// ...client uploads parts via presigned UploadPart URLs, collects { ETag, PartNumber }...

await s3.send(new CompleteMultipartUploadCommand({
  Bucket: 'videos',
  Key: `videos/${videoId}/original.${ext}`,
  UploadId,
  MultipartUpload: { Parts: parts }, // [{ ETag, PartNumber }, ...] ordered
}));
```

> **Note:** `@aws-sdk/lib-storage`'s `Upload` helper does *server-side* multipart (bytes flow
> through whoever runs it). It is the right tool **inside the worker** for storage→storage
> copies, but it is **NOT** the upload path for the 10GB client upload — that must be
> presigned/direct (TD-03), otherwise the 10GB stream would transit the API (automatic fail).

---

## @aws-sdk/s3-request-presigner (`^3.1076.0`)

`getSignedUrl(client, command, { expiresIn })` — turns any S3 command into a time-limited URL
the **browser** uses directly. The keystone of TD-03 (upload) and TD-07 (delivery): the API
mints URLs, the client moves the bytes.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// TD-03 — presign each multipart part (client PUTs bytes to this URL)
const partUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket: 'videos', Key: key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// TD-07 — presign GET for streaming + download.
// Storage serves HTTP Range/206 natively; access checks + view-count happen at minting time.
const watchUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: 'videos', Key: key }),
  { expiresIn: 3600 },
);
```

> `expiresIn` is **seconds** (default 900). Keep upload-part URLs short-lived; mint GET URLs
> on demand per playback/download so the access check is always current.

---

## nanoid (`^5.1.16`)

Tiny, URL-safe, collision-resistant ID generator. Covers **TD-06** (public video URL id,
stored as a `UNIQUE` column, regenerate-on-conflict).

```typescript
import { nanoid, customAlphabet } from 'nanoid';

// Default: 21 chars, alphabet A-Za-z0-9_- (collision prob ≈ UUID v4)
const publicId = nanoid();            //=> "V1StGXR8_Z5jdHi6B-myT"

// Or fix a size / alphabet for shorter, YouTube-style watch ids:
const videoId = customAlphabet(
  '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  11,
);
videoId();                            //=> 11-char opaque id
```

> **⚠ ESM-only gotcha (load-bearing for implement):** nanoid **5.x is pure ESM** and cannot be
> `require()`d from CommonJS. NestJS compiles to CommonJS by default. Options for the implement
> phase: (a) use a dynamic `import('nanoid')`; (b) pin **`nanoid@^3.3.11`** (last CJS-compatible
> line, same API); or (c) move the project to ESM output. Pick during `/plan-build`; the safest
> low-friction choice for a CJS Nest project is option (b). The `UNIQUE`-column +
> regenerate-on-conflict guard (TD-06) is independent of the version chosen.
