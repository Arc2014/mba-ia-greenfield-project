---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-30
scope_description: "Backend foundation for video upload and processing: object-storage access (S3/MinIO), large-file (10GB) upload strategy, background-processing queue, video worker (ffmpeg/ffprobe) for metadata + thumbnail, unique video URL, streaming + download delivery, and the video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the entire phase: videos module, object-storage integration, queue + worker, ffmpeg processing, streaming/download endpoints, and the videos table/migration. New Docker Compose services (object storage, queue, worker) are part of this subproject's infra.
- `next-frontend/` — Frontend deferred. The video UI (upload/player/management screens) is explicitly **out of scope** for Phase 03 per `desafio.md` ("a interface de vídeo não faz parte do escopo desta fase"). No open decision in this document. The upload/streaming HTTP contracts defined here are written so a future FE/client can consume them.

> **Tooling note (context7):** the `context7` MCP server is **not connected in this session**, so the per-option docs below were verified via official sources / web search instead. Exact version pinning of every chosen library MUST be confirmed via context7 during **`plan-resolve`** (→ `library-refs.md`), as required by the project CLAUDE.md. Where a version is mentioned below it is indicative, not pinned.

> **Installed backend stack (from `nestjs-project/package.json`):** NestJS 11, TypeORM 0.3.28, PostgreSQL 17 (`pg` 8.20), Jest 30, argon2, joi, class-validator, @nestjs/config, @nestjs/throttler, @nestjs/swagger. **No queue lib, no storage SDK, no ffmpeg wrapper currently installed** — all three are net-new for this phase. Current `compose.yaml` runs only `nestjs-api`, `db`, `mailpit` (no Redis).

---

## TD-01: Background-Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video processing (metadata extraction + thumbnail) is heavy and MUST run off the request path. The project plan marks the queue technology explicitly as "TBD" — this is the headline stack decision of the phase. The choice drives a new Compose service (or not), the worker's connection model, retry/backoff semantics, and observability.

**Options:**

### Option A: BullMQ (Redis-backed) + `@nestjs/bullmq`
- Redis-based job queue, successor to Bull. Official NestJS integration package (`@nestjs/bullmq`). Native delayed jobs, exponential backoff, retries, progress events, repeatable jobs, and Bull Board UI for observability.
- **Pros:** Canonical choice for media-processing pipelines. First-class NestJS DI (`@Processor`, `@InjectQueue`). Mature retry/backoff/DLQ + the best observability tooling (Bull Board). Huge ecosystem.
- **Cons:** Adds **Redis** as a new Compose service and a new infra dependency to run in dev, CI, and integration tests. One more moving part to keep healthy.

### Option B: pg-boss (PostgreSQL-backed)
- Job queue that lives in the existing PostgreSQL via `SKIP LOCKED`. No Redis. ACID guarantees; jobs are rows in the project's own DB.
- **Pros:** **Zero new infrastructure** — reuses PostgreSQL 17 already in the stack (mirrors the Phase 02 reasoning style: "Postgres is already here"). ACID job state. Simpler Compose and simpler integration tests (no Redis to boot). Retries, scheduling, and archiving supported.
- **Cons:** No official NestJS package (thin manual provider needed). Less mature observability (no Bull Board equivalent). Throughput ceiling lower than Redis under heavy load — irrelevant at this phase's volume.

### Option C: RabbitMQ via `@nestjs/microservices`
- Dedicated message broker; NestJS has a built-in RabbitMQ transport.
- **Pros:** True broker semantics, routing, durable across services. Scales to many consumers.
- **Cons:** Heaviest infra to add and operate. Overkill for a single producer → single worker pipeline. No built-in job-retry/backoff ergonomics like BullMQ; more plumbing for a simple processing queue.

**Recommendation:** **Option A (BullMQ + `@nestjs/bullmq`)** — video transcoding/thumbnailing is BullMQ's canonical use case; the official Nest package, built-in backoff/retry/DLQ, job progress, and Bull Board match exactly what TD-08's failure handling needs. The cost is one extra Compose service (Redis), which is standard and cheap. **If avoiding new infrastructure is the priority, Option B (pg-boss) is the strong alternative** — it reuses PostgreSQL and simplifies the Compose/test surface, at the cost of weaker tooling and a hand-rolled Nest integration.

**Decision:** A (BullMQ + `@nestjs/bullmq`)

---

## TD-02: Object-Storage Access (SDK, bucket/key layout, presigning)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage backend is **given** — S3-compatible, run as **MinIO** locally in Docker, swappable for AWS S3 in prod (per `desafio.md`). The open decision is *how* to talk to it: which client SDK, how buckets/keys are organized, and how presigned URLs are generated. This client is also what TD-03 (upload) and TD-07 (delivery) build on.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Official AWS SDK, modular. Points at MinIO via `endpoint` + `forcePathStyle: true`. Supports multipart APIs (`CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`) and presigning of every operation.
- **Pros:** Same code works against MinIO (dev) and AWS S3 (prod) — true drop-in swap. First-class presigned **multipart** support (required by TD-03 for 10GB). Tree-shakeable, actively maintained, huge docs base.
- **Cons:** More verbose API surface than MinIO's own client. Multipart orchestration is several calls.

### Option B: MinIO JS client (`minio`)
- MinIO's own Node client. Simpler helpers like `presignedPutObject`, `presignedGetObject`.
- **Pros:** Slightly terser API; built specifically for MinIO.
- **Cons:** Reframes the stack around MinIO rather than the S3 contract; prod swap to AWS S3 is less seamless. Presigned **multipart** ergonomics weaker than AWS SDK v3. Adds a MinIO-specific dependency for something the standard S3 SDK already covers.

**Recommendation:** **Option A (AWS SDK v3)** — the project explicitly targets "S3 (compatible), MinIO in dev → S3 in prod"; the official S3 SDK is the only option that keeps that swap a config change. Its presigned-multipart support is the foundation TD-03 needs. **Proposed layout (for your review):** a single bucket `videos`, key scheme `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`; bucket and endpoint/credentials supplied via env (Joi-validated, Compose service name as host — never `localhost`).

**Decision:** A (AWS SDK v3 — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`; single `videos` bucket, `videos/{videoId}/...` keys)

---

## TD-03: 10GB Upload Strategy + Draft Pre-Registration Handshake

**Scope:** Backend

**Capability:** Transversal — covers: `Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance`, `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`

**Context:** A 10GB file must never flow through the API in a way that blocks it — `desafio.md` lists "passar o arquivo de 10GB pela API de forma que trave o sistema" as an **automatic fail**. The decision also defines the handshake: when the draft video row is created, how the client uploads, and how the system learns the upload finished to enqueue processing.

**Options:**

### Option A: Presigned **multipart** direct-to-storage (API orchestrates only)
- Client calls `POST /videos` → API creates the **draft** video row and a multipart upload in storage, returns presigned `UploadPart` URLs. Client uploads parts **directly to MinIO/S3** (API never sees the bytes). Client then calls `POST /videos/{id}/complete` → API completes the multipart upload and **enqueues** the processing job.
- **Pros:** API is fully out of the byte path — zero blocking, scales. Multipart is **required anyway**: S3/MinIO cap a single `PUT` at 5GB, so 10GB is impossible without multipart (parts 5MB–5GB, up to 10,000 parts). Per-part retry gives natural resumability on flaky connections.
- **Cons:** More orchestration endpoints (init/sign/complete) and client logic. Need to handle abandoned/incomplete uploads (lifecycle/abort policy).

### Option B: Single presigned `PUT` URL
- API creates the draft + one presigned `PUT` URL; client uploads the whole file in one request directly to storage.
- **Pros:** Simplest possible flow; still keeps bytes out of the API.
- **Cons:** **Fails the requirement** — a single S3/MinIO `PUT` is capped at **5GB**, so 10GB cannot be uploaded this way. No resumability; one dropped connection restarts the entire 10GB.

### Option C: tus resumable protocol (`@tus/server` + `@tus/s3-store`)
- API hosts a tus endpoint; client uploads in resumable chunks; the tus S3 store streams chunks to storage.
- **Pros:** Best-in-class resumable UX; protocol-level pause/resume.
- **Cons:** Bytes proxy **through the API** (streamed to S3) — heavier API/worker load and runs against the "don't pass the file through the API" guidance. Extra moving part and protocol to operate.

**Recommendation:** **Option A (presigned multipart direct-to-storage)** — it's the only option that satisfies the 10GB requirement (5GB single-PUT cap rules out B), keeps the API out of the byte path, and gives per-part resumability without a proxy protocol. The draft row is created at init; processing is enqueued at `complete`. Incomplete uploads handled via a storage abort/lifecycle policy (detail for the plan).

**Decision:** A (Presigned multipart direct-to-storage; draft row at init, processing enqueued at `complete`)

---

## TD-04: Video Worker Deployment Model

**Scope:** Repo-wide

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The processing worker must be a real, separately-running consumer (the queue's worker), brought up in Docker Compose alongside the backend. The decision is how it is packaged and run relative to the API.

**Options:**

### Option A: Separate Compose service from the **same image/codebase**, different entrypoint
- A `video-worker` service built from the same `nestjs-project` image, started with a worker command (a NestJS standalone application context that registers the BullMQ `@Processor`). Shares entities, config, and the storage client with the API.
- **Pros:** Real separate process/container (own CPU/mem; ffmpeg can't starve the API). Maximal code reuse (TypeORM entities, config, DI). One image to build. Matches the target architecture (API ⟶ queue ⟶ Worker) in `software-arch.mermaid`.
- **Cons:** Needs a second entrypoint/command and a worker bootstrap; the image must include ffmpeg (see TD-05).

### Option B: In-process worker inside the API container
- The API process also runs the BullMQ worker (same container/process).
- **Pros:** Simplest — no new service.
- **Cons:** ffmpeg CPU spikes degrade API latency; can't scale workers independently; contradicts the "separate worker" architecture and the spirit of the phase. Reject.

### Option C: Separate worker repo/microservice
- Fully independent service/repo with its own deploy.
- **Pros:** Strong isolation; independent deploy.
- **Cons:** Over-engineered for this phase; duplicates config/entities; more ops. Reject.

**Recommendation:** **Option A (separate Compose service, same image, distinct command)** — gives true process isolation for ffmpeg while reusing the backend codebase (entities, config, queue connection). It's the continuity-friendly choice and matches the documented target architecture.

**Decision:** A (Separate Compose service `video-worker` from the same image, distinct worker command)

---

## TD-05: Video Processing Tooling (metadata + thumbnail)

**Scope:** Backend

**Capability:** Transversal — covers: `Processamento automático do vídeo após upload (extração de duração e metadados)`, `Geração automática de thumbnail a partir de um frame do vídeo`

**Context:** The worker must extract duration/metadata and generate a thumbnail from a frame. ffmpeg/ffprobe are the de-facto tools; the decision is **how** to invoke them from Node and how the binary is provided in the worker image.

**Options:**

### Option A: Direct `ffmpeg`/`ffprobe` via `child_process.spawn`, binary installed in the worker image
- Worker image installs the `ffmpeg` apt package; the worker shells out to `ffprobe` (JSON metadata/duration) and `ffmpeg` (extract a frame → thumbnail), parsing stdout/stderr.
- **Pros:** No dependency on an abandoned wrapper. Full control over flags. Uses a maintained, distro-provided ffmpeg. Transparent and testable against real media in Compose.
- **Cons:** Must build the command strings and parse output yourself (thin internal helper). Slightly more code than a fluent wrapper would be.

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API over the ffmpeg CLI.
- **Cons / status:** **The `fluent-ffmpeg` repository was archived on 2025-05-22 — unmaintained, read-only, and does not work reliably with recent ffmpeg.** Introducing a dead dependency into a greenfield phase is a liability. **Reject.**

### Option C: Bundled static binary (`ffmpeg-static` / `@ffmpeg-installer/ffmpeg`) + thin wrapper
- npm package ships an ffmpeg binary; worker invokes it.
- **Pros:** No apt step; pinned binary via npm.
- **Cons:** Binaries lag upstream ffmpeg; larger node_modules; still need to invoke ffmpeg yourself. A distro apt package is simpler and better-maintained for a Linux worker container.

**Recommendation:** **Option A (direct `ffmpeg`/`ffprobe` via `child_process`, apt-installed in the worker image)** — explicitly chosen *because* `fluent-ffmpeg` is archived (Option B). Direct invocation is robust, maintained, and gives precise control over metadata parsing and frame selection for the thumbnail. A small internal `FfmpegService` wraps the calls.

**Decision:** A (Direct `ffmpeg`/`ffprobe` via `child_process`, apt-installed in the worker image; internal `FfmpegService`)

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, collision-free public identifier used in its URL (YouTube-style), distinct from the internal primary key. The decision is the id scheme stored as a unique column and surfaced in routes.

**Options:**

### Option A: `nanoid` (random, URL-safe)
- Generates short, opaque, URL-safe ids (e.g., 11 chars) with strong collision resistance; stored as a unique column.
- **Pros:** Tiny, fast, URL-safe by default. Opaque (doesn't leak row counts/order). Configurable length to tune collision probability. Trivial unique-constraint + retry-on-conflict.
- **Cons:** Random → must persist (not derivable). Astronomically rare collision handled by a unique constraint + regenerate.

### Option B: `sqids` (reversible encoding of the numeric id)
- Encodes the numeric PK into a short string (successor to hashids).
- **Pros:** Deterministic from the PK; no extra stored column strictly required.
- **Cons:** Reversible/enumerable unless salted carefully — can leak ordering/volume. Couples the public id to the internal PK. Weaker fit for "unlisted" privacy.

### Option C: UUID v4
- Standard 128-bit random identifier.
- **Pros:** Ubiquitous, collision-proof in practice, native PG `uuid` type.
- **Cons:** Long and ugly in URLs (36 chars) — poor fit for a short "watch" URL.

**Recommendation:** **Option A (`nanoid`)** — short, opaque, URL-friendly, and privacy-preserving (important for unlisted videos in Phase 05), stored as a `UNIQUE` column with a regenerate-on-conflict guard. Reversible schemes (B) leak ordering; UUID (C) is too long for a watch URL.

**Decision:** A (`nanoid` stored as a `UNIQUE` column, regenerate-on-conflict)

---

## TD-07: Streaming + Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: `Reprodução via streaming (sem necessidade de download completo)`, `Download do vídeo pelo usuário`

**Context:** Playback must stream without forcing a full download (HTTP Range / 206 Partial Content), and a full download must be available. The decision is whether the API proxies bytes or delegates to storage, and how Range is satisfied — it mirrors the upload philosophy (keep large bytes off the API).

**Options:**

### Option A: Presigned `GET` + redirect; storage serves Range natively
- The public watch endpoint resolves the unique id → returns a short-lived presigned `GET` URL (302 redirect, or JSON for the player). The browser `<video>` element issues Range requests **directly to MinIO/S3**, which natively returns 206 Partial Content. Download = same presigned `GET` with `response-content-disposition: attachment`.
- **Pros:** API stays out of the byte path for both streaming and download — scales, no 10GB proxying. Storage handles Range/206 correctly and efficiently. Short-lived URLs suit anonymous + unlisted access.
- **Cons:** Exposes a temporary storage URL to the client. Per-request authorization must be enforced when minting the URL (fine: anonymous allowed for public/unlisted-by-link).

### Option B: Proxy streaming through the API with Range
- API reads the object from storage with the requested byte range and pipes it back as 206 (NestJS `StreamableFile` / manual range handling), keeping the storage URL private.
- **Pros:** Storage stays fully private; fine-grained per-request auth and metrics (view counting) at the API.
- **Cons:** API sits in the byte path for potentially huge files — load/latency cost, the very thing the phase avoids on the upload side. More backpressure/streaming code to get right.

### Option C: Hybrid
- Presigned redirect for public/ready videos (A); API proxy (B) only where strict per-request control is needed.
- **Pros:** Flexibility.
- **Cons:** Two delivery paths to build/test now; premature for this phase.

**Recommendation:** **Option A (presigned `GET` + storage-native Range/206)** for both streaming and download — consistent with the upload design (bytes never transit the API), and MinIO/S3 implement Range correctly out of the box. View-count and access checks happen when the presigned URL is minted. Option B remains the fallback if a future requirement demands the API fully mediate the stream.

**Decision:** A (Presigned `GET` + storage-native Range/206 for both streaming and download)

---

## TD-08: Video Status Lifecycle + Processing Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: `Pré-cadastro automático do vídeo como rascunho ao iniciar o upload`, `Processamento automático do vídeo após upload (extração de duração e metadados)`

**Context:** The video row carries a status from draft through processing to ready/error, persisted in the DB. The decision fixes the state set, the transitions, and what happens when ffmpeg processing fails — this drives the data model (status enum), the queue's retry config (TD-01), and the Error Catalog.

**Options:**

### Option A: Minimal lifecycle `DRAFT → PROCESSING → READY | ERROR` with queue auto-retry
- Draft on upload init; PROCESSING when the job starts; READY on success (duration/metadata/thumbnail persisted); ERROR after the queue exhausts retries (e.g., 3 attempts, exponential backoff), storing a failure reason. Re-processing = re-enqueue.
- **Pros:** Simple, matches the phase wording exactly. Maps cleanly to BullMQ attempts/backoff and failed-job handling. Easy to test each transition.
- **Cons:** No explicit `UPLOADING` state between draft and processing (upload progress inferred client-side).

### Option B: Richer state machine (`DRAFT → UPLOADING → PROCESSING → READY | FAILED` + DLQ)
- Adds an explicit UPLOADING state and a dead-letter queue for terminally failed jobs with manual requeue.
- **Pros:** More operational visibility; explicit terminal-failure handling.
- **Cons:** More states/transitions and infra (DLQ) than the phase requires; risk of over-engineering before there's a UI consuming it.

**Recommendation:** **Option A (minimal `DRAFT → PROCESSING → READY | ERROR`)** — it is exactly what the capabilities ask for and aligns 1:1 with BullMQ's attempts/backoff/failed semantics from TD-01. Persist a failure reason on ERROR and allow re-enqueue. Promote to Option B's DLQ/extra states later only if operational need appears.

**Decision:** A (`DRAFT → PROCESSING → READY | ERROR`; persist failure reason on ERROR; re-enqueue to reprocess)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Background-processing queue technology | A — BullMQ + `@nestjs/bullmq` (pg-boss strong no-Redis alt) | **A — BullMQ** |
| TD-02 | Backend | Object-storage access (SDK, buckets, presigning) | A — AWS SDK v3 (`@aws-sdk/client-s3` + presigner) | **A — AWS SDK v3** |
| TD-03 | Backend | 10GB upload strategy + draft handshake | A — Presigned multipart direct-to-storage | **A — Presigned multipart** |
| TD-04 | Repo-wide | Video worker deployment model | A — Separate Compose service, same image, distinct command | **A — Separate service, same image** |
| TD-05 | Backend | Video processing tooling (metadata + thumbnail) | A — Direct `ffmpeg`/`ffprobe` via `child_process` (fluent-ffmpeg archived) | **A — Direct `ffmpeg`/`ffprobe`** |
| TD-06 | Backend | Unique video URL identifier | A — `nanoid` unique column | **A — `nanoid`** |
| TD-07 | Backend | Streaming + download delivery | A — Presigned `GET` + storage-native Range/206 | **A — Presigned `GET` + Range** |
| TD-08 | Backend | Video status lifecycle + failure handling | A — `DRAFT → PROCESSING → READY \| ERROR` + queue retry | **A — `DRAFT→PROCESSING→READY\|ERROR`** |

---

## Sources (verification, pending context7 pinning at plan-resolve)

- fluent-ffmpeg archived (2025-05-22): https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324 and repo https://github.com/fluent-ffmpeg/node-fluent-ffmpeg
- Queue comparison (BullMQ vs pg-boss, 2026): https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026 and pg-boss https://github.com/timgit/pg-boss
- S3 limits (single PUT 5GB; multipart parts 5MB–5GB, up to 10,000 parts / 5TB) — AWS S3 documentation (to re-confirm via context7 at resolve).
