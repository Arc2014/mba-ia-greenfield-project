---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-30T08:20:32-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-30T09:30:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-06-30T08:20:32-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-06-30T08:20:32-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-30T08:20:32-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-30T08:20:32-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-30T09:32:41-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações/visibilidade do vídeo e painel de gerenciamento do canal (Fase 04); página de visualização e player (Fase 05); interações sociais — likes, comentários, inscrições (Fase 06); home, busca e responsividade (Fase 07). Qualquer UI de vídeo (upload/player/listagem) — o frontend não faz parte desta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/` (módulo de vídeos, integração com object storage, fila + worker, processamento ffmpeg, endpoints de streaming/download, migration da tabela de vídeos, novos serviços no `compose.yaml`).

**Deferred subprojects:** `next-frontend/` — a interface de vídeo (telas de upload, player, listagem) fica diferida para fases futuras; não há decisão aberta de frontend nesta fase.

**Sequencing notes:** Depende da Fase 01 (Configuração Base) e da Fase 02 (Cadastro, Login e Gerenciamento de Conta) — os vídeos pertencem a um canal (relação criada na Fase 02).

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior; fornece usuário/canal e a infraestrutura de auth/guards).
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (next; consome a entidade de vídeo desta fase).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Background-Processing Queue Technology | decided | A (BullMQ + `@nestjs/bullmq`) | `@nestjs/bullmq`, `bullmq` (+ Redis infra) |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Object-Storage Access (SDK, buckets, presigning) | decided | A (AWS SDK v3) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | 10GB Upload Strategy + Draft Handshake | decided | A (presigned multipart direct-to-storage) | — _(uses AWS SDK v3)_ |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Repo-wide | Video Worker Deployment Model | decided | A (separate Compose service, same image) | — _(infra/compose)_ |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Processing Tooling (metadata + thumbnail) | decided | A (direct `ffmpeg`/`ffprobe` via `child_process`) | `ffmpeg` system binary _(no npm wrapper — fluent-ffmpeg archived)_ |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL Identifier | decided | A (`nanoid`) | `nanoid` |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Streaming + Download Delivery | decided | A (presigned `GET` + Range/206) | — _(uses AWS SDK v3)_ |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle + Failure Handling | decided | A (`DRAFT → PROCESSING → READY \| ERROR`) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-03 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-08 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-05, phase-03-videos/TD-08 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + `@nestjs/bullmq` — video processing is BullMQ's canonical use case; the official Nest package, built-in backoff/retry/DLQ, job progress, and Bull Board match TD-08's failure handling. Cost is one extra Compose service (Redis). pg-boss is the strong alternative if avoiding new infrastructure is the priority.

**Libraries:** `@nestjs/bullmq`, `bullmq` (+ Redis service in compose)

### phase-03-videos/TD-02

**Recommendation:** AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) — the only option that keeps the MinIO→S3 swap a config change; first-class presigned-multipart support underpins TD-03. Layout: single `videos` bucket, keys `videos/{videoId}/original.<ext>` and `videos/{videoId}/thumbnail.jpg`; endpoint/credentials via Joi-validated env using the Compose service name as host.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-03

**Recommendation:** Presigned multipart direct-to-storage — the only option satisfying 10GB (single-PUT caps at 5GB), keeping the API out of the byte path, with per-part resumability. `POST /videos` creates the DRAFT row + multipart upload and returns presigned part URLs; client uploads parts directly to storage; `POST /videos/{id}/complete` completes the multipart upload and enqueues processing. Incomplete uploads handled via a storage abort/lifecycle policy.

**Libraries:** — _(uses AWS SDK v3 from TD-02)_

### phase-03-videos/TD-04

**Recommendation:** Separate Compose service `video-worker` from the same image, started with a distinct worker command (a NestJS standalone context registering the BullMQ `@Processor`) — true process isolation for ffmpeg while reusing entities/config/queue connection. Matches the target architecture (API ⟶ queue ⟶ Worker).

**Libraries:** — _(infra/compose; reuses backend deps)_

### phase-03-videos/TD-05

**Recommendation:** Direct `ffmpeg`/`ffprobe` via `child_process`, apt-installed in the worker image, wrapped by an internal `FfmpegService` — chosen because `fluent-ffmpeg` was archived 2025-05-22. `ffprobe` extracts duration/metadata; `ffmpeg` extracts a frame for the thumbnail.

**Libraries:** `ffmpeg` system binary (worker image) — no npm wrapper

### phase-03-videos/TD-06

**Recommendation:** `nanoid` stored as a `UNIQUE` column with regenerate-on-conflict — short, opaque, URL-friendly, and privacy-preserving (matters for unlisted videos in Fase 05). Reversible schemes leak ordering; UUID is too long for a watch URL.

**Libraries:** `nanoid`

### phase-03-videos/TD-07

**Recommendation:** Presigned `GET` + storage-native Range/206 for both streaming and download — consistent with the upload design (bytes never transit the API); MinIO/S3 implement Range correctly. View-count and access checks happen when the presigned URL is minted; download reuses the same mechanism with `response-content-disposition: attachment`. API proxy with Range remains the fallback if a future requirement demands full API mediation.

**Libraries:** — _(uses AWS SDK v3 from TD-02)_

### phase-03-videos/TD-08

**Recommendation:** Lifecycle `DRAFT → PROCESSING → READY | ERROR`, aligned 1:1 with BullMQ attempts/backoff/failed semantics — DRAFT at upload init, PROCESSING when the job starts, READY on success (duration/metadata/thumbnail persisted), ERROR after retries exhaust (persist a failure reason; re-enqueue to reprocess).

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only (decision diverged from the recommended @nestjs/passport to keep the dependency surface smaller). Authenticated routes are protected by the global JWT guard; public routes opt out explicitly.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — the documented NestJS approach, used via the global `ValidationPipe`; the project already uses decorators extensively (TypeORM entities, DI).

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — machine-readable error codes in a simple `{ statusCode, error, message }` envelope. This is the error contract all subsequent phases (including videos endpoints) must emit.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — native NestJS integration; rate limiting scoped per module via `APP_GUARD`, with `@SkipThrottle()` for exemptions.

**Libraries:** `@nestjs/throttler@^6.x`

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger` + CLI plugin) — preserves class-validator (phase-02 TD-06) without re-platform; `classValidatorShim: true` infers DTO schemas, while operations, typed responses per status, and error contracts (aligned to TD-07) require explicit `@ApiOperation`/`@ApiResponse`/`@ApiBody`/`@ApiParam`/`@ApiQuery` decorators. Videos endpoints must follow this.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + exported `openapi.json`) — interactive UI for dev/QA plus a versioned artifact for future FE codegen; drift visible as a PR diff.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Swagger UI only in dev/staging via env flag) — minimizes production attack surface; the committed `openapi.json` covers external spec consultation. Videos endpoints inherit this exposure policy.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'`, then imports the config factory and calls it as a plain function. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `autoLoadEntities: true`, `synchronize: false`; schema changes ship as versioned migrations in `src/database/migrations/`. _(from phase 01)_
- Each domain feature is its own NestJS module (Controller = HTTP routing, Service = business logic), registered in `AppModule`. _(from phase 02)_
- Domain errors are emitted through the custom exception filter as `{ statusCode, error, message }` with machine-readable domain codes; framework `HttpException`s keep their default handling. _(from phase 02 — TD-07)_
- Request DTOs are validated with class-validator + class-transformer via the global `ValidationPipe`. _(from phase 02 — TD-06)_
- Authenticated routes are protected by the global JWT guard built on `@nestjs/jwt`; anonymous/public routes opt out explicitly. _(from phase 02 — TD-02)_
- Rate limiting via `@nestjs/throttler` scoped per module with `APP_GUARD`; `@SkipThrottle()` for exemptions. _(from phase 02 — TD-08)_
- REST endpoints are documented with `@nestjs/swagger` (CLI plugin + explicit `@ApiOperation`/`@ApiResponse`/error contracts); Swagger UI is gated to dev/staging and `openapi.json` is exported. _(from openapi-docs-nestjs — TD-01..03)_
- All `npm`/`npx`/`tsc`/test commands run **inside the container**; service hosts use the Compose service name (e.g., `db`), never `localhost`. _(from project CLAUDE.md)_
- Tests use the suffix contract `*.spec.ts` (unit, no I/O) / `*.integration-spec.ts` (real DB/services) / `*.e2e-spec.ts` (full HTTP via supertest); integration + e2e run with `--runInBand`. _(from project CLAUDE.md)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` não inicializado naquela fase; superfícies de UI começam em fase posterior. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for the authoritative layer requirements per artifact type. Phase 03 introduces a new domain module plus real external infrastructure (queue + worker + object storage), so the pyramid must be exercised against **real** services from Compose — per the project rule and the challenge, do not mock what Compose can run.

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| `Video` TypeORM entity + `CreateVideos` migration | integration (run/revert against real PostgreSQL) |
| Repository / data access | integration (real DB) |
| Domain service (videos lifecycle, status transitions, nanoid id) | unit (pure logic, collaborators mocked) + integration (real DB) |
| Object-storage adapter (presigned multipart, presigned GET) | integration (real MinIO via Compose) |
| Queue producer (enqueue on upload complete) | integration (real BullMQ + Redis) |
| Queue processor / worker (ffmpeg pipeline) | integration (real Redis + real `ffmpeg`/`ffprobe` + real MinIO on sample media) |
| `FfmpegService` (duration/metadata extraction, thumbnail) | integration (real `ffmpeg` on a small fixture video) |
| HTTP endpoints (upload init/complete, watch/stream, download, list) | e2e (`*.e2e-spec.ts` via supertest, full HTTP cycle) |

Specific layer coverage per Step Implementation is recorded in `progress.md` during implementation.

### next-frontend

_Deferred subproject — testing requirements will be defined when the video UI phase begins._
