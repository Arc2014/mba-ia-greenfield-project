---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-06-30T09:33:03-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-30T09:32:41-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-30T09:30:32-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-06-30T08:20:32-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o domínio de vídeos no `nestjs-project`: armazenamento S3/MinIO, upload direto de até 10GB via multipart presigned com pré-cadastro do rascunho, processamento assíncrono em fila (BullMQ + worker dedicado) que extrai duração/metadados e gera thumbnail com ffmpeg, URL pública única por vídeo, e entrega por streaming (Range/206) e download — sem que os bytes do arquivo transitem pela API.

---

## Step Implementations

### SI-03.1 — Modelar entidade Video + migration

**Description:** Cria a entidade `Video`, o enum de status e a migration que materializa a tabela com seus índices, mais a relação com `Channel` — a fundação de dados de toda a fase.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — entidade `Video` com as colunas do `### Data Model` (per `phase-03-videos/TD-06`, `phase-03-videos/TD-08`)
2. Criar o enum `VideoStatus` com `DRAFT | PROCESSING | READY | ERROR` (per `phase-03-videos/TD-08`)
3. Adicionar a relação `Channel` 1—N `Video` (many-to-one via `channel_id`, on delete cascade) na entidade `Channel` da Fase 02
4. Criar a migration `CreateVideos` em `src/database/migrations/` — enum de status, tabela `video`, índice unique em `public_id`, índices em `channel_id` e `status` (`synchronize: false`, per `## Inherited Conventions`)
5. Criar `VideosModule` com `TypeOrmModule.forFeature([Video])` e registrá-lo em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity + `CreateVideos` migration | Integration: defaults (`status=DRAFT`, `views_count=0`), unique `public_id`, FK cascade, run/revert contra PostgreSQL real | `src/videos/entities/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Persistir um `Video` sem `status` aplica o default `DRAFT`.
- Persistir dois `Video` com o mesmo `public_id` viola a constraint unique.
- Remover um `Channel` remove em cascata os `Video` associados.
- A migration `CreateVideos` aplica e reverte sem erro contra o PostgreSQL real.

---

### SI-03.2 — Infra: Redis, MinIO e configuração validada

**Description:** Sobe a infraestrutura nova da fase (fila e object storage) no Compose e expõe a configuração tipada/validada por Joi, seguindo as convenções de config da Fase 01.

**Technical actions:**

1. Adicionar os serviços `redis` e `minio` ao `compose.yaml` — hosts referenciados pelo nome de serviço Compose, nunca `localhost` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
2. Criar `src/config/storage.config.ts` (`registerAs`) + entradas no schema Joi para endpoint, credenciais e bucket S3 (per `phase-03-videos/TD-02`, `## Inherited Conventions`)
3. Criar `src/config/queue.config.ts` (`registerAs`) + entradas no schema Joi para host/porta do Redis (per `phase-03-videos/TD-01`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `redis` e `minio` com status `running`.
- Subir a aplicação sem as variáveis de S3/Redis obrigatórias falha na validação Joi do boot.
- As factories de config são injetáveis via `ConfigType<typeof storageConfig>` / `ConfigType<typeof queueConfig>`.

---

### SI-03.3 — Adapter de object storage (S3/MinIO)

**Description:** Encapsula o acesso ao storage S3-compatível num `StorageService` que cobre o multipart presigned (init/part/complete/abort) e o GET presigned — a base de upload (TD-03) e entrega (TD-07).

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` (per `phase-03-videos/TD-02`)
2. Criar `src/videos/storage/storage.service.ts` — `S3Client` com `forcePathStyle: true` para MinIO + `createMultipartUpload`, `presignUploadPart`, `completeMultipartUpload`, `abortMultipartUpload` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
3. Adicionar `presignGet(key, { expiresIn, contentDisposition? })` para streaming e download (per `phase-03-videos/TD-07`)
4. Registrar `StorageService` no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration: round-trip multipart presigned + GET presigned contra MinIO real do Compose | `src/videos/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.2 (config + serviço MinIO)

**Acceptance criteria:**

- `createMultipartUpload` retorna um `UploadId` e `presignUploadPart` gera uma URL que aceita `PUT` de uma parte no MinIO real.
- Após enviar as partes, `completeMultipartUpload` monta o objeto e ele fica legível por `presignGet`.
- `presignGet` com `contentDisposition: attachment` produz uma URL cujo download vem com o header `Content-Disposition: attachment`.
- `abortMultipartUpload` remove um upload incompleto.

---

### SI-03.4 — Fila de processamento + producer

**Description:** Configura a fila BullMQ `video-processing` (com retry/backoff alinhados ao lifecycle de TD-08) e o producer que enfileira o job ao concluir o upload.

**Technical actions:**

1. Instalar `bullmq` e `@nestjs/bullmq` (per `phase-03-videos/TD-01`)
2. Configurar `BullModule.forRootAsync` (conexão Redis via `queue.config`) e `registerQueue('video-processing')` com `defaultJobOptions` `attempts: 3` + `backoff` exponencial + `removeOnComplete` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-08`)
3. Criar `src/videos/processing/video-processing.producer.ts` — injeta a `Queue` e expõe `enqueue(videoId, originalKey)` com o payload de `### Events/Messages` (per `phase-03-videos/TD-01`)
4. Registrar o `BullModule` e o producer no `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration: `enqueue` cria o job em `video-processing` com `attempts`/`backoff` corretos contra BullMQ + Redis reais | `src/videos/processing/video-processing.producer.integration-spec.ts` |

**Dependencies:** SI-03.2 (Redis + queue config)

**Acceptance criteria:**

- `enqueue(videoId, originalKey)` adiciona um job em `video-processing` cujo payload contém `videoId` e `originalKey`.
- O job é criado com `attempts: 3` e `backoff` do tipo `exponential`.

---

### SI-03.5 — Endpoints de upload (handshake DRAFT → PROCESSING)

**Description:** Implementa o serviço e o controller do handshake de upload: `POST /videos` pré-cadastra o rascunho e devolve as URLs presigned das partes; `POST /videos/:id/complete` conclui o multipart, transiciona para `PROCESSING` e enfileira o processamento.

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload.plan.md`

**Technical actions:**

1. Criar `src/videos/dto/init-upload.dto.ts` e `src/videos/dto/complete-upload.dto.ts` com class-validator conforme `### API Contracts → #### Validation Rules`
2. Criar `src/videos/videos.service.ts` — `initUpload`: gera `public_id` com `nanoid` (regenerate-on-conflict), cria o `Video` em `DRAFT`, abre o multipart e devolve as partes presigned (per `phase-03-videos/TD-03`, `phase-03-videos/TD-06`)
3. Adicionar `completeUpload`: valida ownership e estado `DRAFT`, conclui o multipart, transiciona para `PROCESSING` e chama `producer.enqueue` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-08`)
4. Criar `src/videos/videos.controller.ts` — `POST /videos` e `POST /videos/:id/complete` protegidos pelo guard JWT, com decorators `@nestjs/swagger` e os `errorCode`s de `### Error Catalog` (per `### API Contracts`, `### Authorization Matrix`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (upload) | Unit: regeneração de `public_id` em colisão, transição `DRAFT → PROCESSING`, guardas de ownership/estado (repo + storage + producer mockados) | `src/videos/videos.service.spec.ts` |

E2E dos endpoints (`POST /videos`, `POST /videos/:id/complete`) são autorados por `/plan-test-specs` no spec referenciado em **Test Specs**.

**Dependencies:** SI-03.1 (entidade), SI-03.3 (storage), SI-03.4 (producer)

**Acceptance criteria:**

- `POST /videos` autenticado com corpo válido retorna `201` com `publicId`, `uploadId` e `parts[]`, e cria o `Video` em `DRAFT`.
- `POST /videos` com `sizeBytes` acima de 10GB retorna `413` com `errorCode: "FILE_TOO_LARGE"`.
- `POST /videos` sem token retorna `401`.
- `POST /videos/:id/complete` por quem não é dono retorna `403` com `errorCode: "VIDEO_NOT_OWNED"`.
- `POST /videos/:id/complete` num vídeo que não está em `DRAFT` retorna `409` com `errorCode: "UPLOAD_ALREADY_COMPLETED"`.
- `POST /videos/:id/complete` válido retorna `200` com `status: "PROCESSING"` e enfileira o job de processamento.

---

### SI-03.6 — Worker de vídeo + pipeline ffmpeg

**Description:** Sobe o serviço `video-worker` (processo separado, mesma imagem) que consome a fila, extrai duração/metadados com `ffprobe`, gera a thumbnail com `ffmpeg` e dirige o lifecycle `PROCESSING → READY | ERROR`.

**Technical actions:**

1. Criar o bootstrap do worker (`src/worker.ts`, `NestApplicationContext` standalone registrando o `@Processor`) e adicionar o serviço `video-worker` ao `compose.yaml` com comando distinto e `ffmpeg` instalado na imagem (per `phase-03-videos/TD-04`)
2. Criar `src/videos/processing/ffmpeg.service.ts` — `ffprobe` para duração/largura/altura e `ffmpeg` para extrair um frame como thumbnail, via `child_process` (per `phase-03-videos/TD-05`)
3. Criar `src/videos/processing/video-processing.consumer.ts` (`@Processor`/`WorkerHost`) — baixa o original, chama o `FfmpegService`, faz upload da thumbnail e persiste `duration_seconds`/`width`/`height`/`thumbnail_key`, transicionando para `READY` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
4. Tratar `@OnWorkerEvent('failed')` — após esgotar as tentativas, transicionar para `ERROR` e persistir `failure_reason`; permitir re-enfileiramento (per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration: extração de duração/metadados e geração de thumbnail sobre um fixture de vídeo pequeno com `ffmpeg`/`ffprobe` reais | `src/videos/processing/ffmpeg.service.integration-spec.ts` |
| `VideoProcessingConsumer` | Integration: job processado fim-a-fim com Redis + MinIO + `ffmpeg` reais leva o vídeo a `READY`; falha de processamento leva a `ERROR` | `src/videos/processing/video-processing.consumer.integration-spec.ts` |

**Dependencies:** SI-03.1 (entidade), SI-03.3 (storage), SI-03.4 (fila)

**Acceptance criteria:**

- Processar um vídeo válido transiciona seu `status` para `READY` e persiste `duration_seconds`, dimensões e `thumbnail_key`.
- A thumbnail gerada fica disponível no storage sob `videos/{id}/thumbnail.jpg`.
- Uma falha de processamento que esgota as 3 tentativas transiciona o `status` para `ERROR` e preenche `failure_reason`.

---

### SI-03.7 — Entrega: streaming e download

**Description:** Expõe a leitura pública do vídeo: metadados/status, streaming via redirect para URL presigned (storage serve Range/206) com contagem de views, e download como anexo — sempre com os bytes fora da API.

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-delivery.plan.md`

**Technical actions:**

1. Adicionar `getWatchInfo(publicId, viewer)` ao `VideosService` — devolve os metadados e a `thumbnailUrl` presigned; vídeo não-`READY` só é visível para o dono (per `phase-03-videos/TD-07`)
2. Adicionar `getStreamRedirect(publicId)` — emite GET presigned, incrementa `views_count` e responde `302` (per `phase-03-videos/TD-07`)
3. Adicionar `getDownloadRedirect(publicId)` — GET presigned com `response-content-disposition: attachment` e `302` (per `phase-03-videos/TD-07`)
4. Adicionar ao controller as rotas públicas `GET /videos/:publicId`, `/videos/:publicId/stream` e `/videos/:publicId/download` (opt-out explícito do guard JWT) com decorators `@nestjs/swagger` (per `### API Contracts`, `### Authorization Matrix`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (delivery) | Unit: incremento de `views_count` na emissão do stream, bloqueio de vídeo não-`READY` para anônimo (storage mockado) | `src/videos/videos.service.spec.ts` |

E2E dos endpoints de leitura (`GET /videos/:publicId`, `/stream`, `/download`) são autorados por `/plan-test-specs` no spec referenciado em **Test Specs**.

**Dependencies:** SI-03.1 (entidade), SI-03.3 (storage), SI-03.5 (controller)

**Acceptance criteria:**

- `GET /videos/:publicId` de um vídeo `READY` retorna `200` com `status`, `durationSeconds`, `thumbnailUrl` e `viewsCount`.
- `GET /videos/:publicId` anônimo de um vídeo não-`READY` retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`.
- `GET /videos/:publicId/stream` de um vídeo `READY` retorna `302` com `Location` apontando para uma URL presigned e incrementa `views_count`.
- `GET /videos/:publicId/stream` de um vídeo não-`READY` retorna `409` com `errorCode: "VIDEO_NOT_READY"`.
- `GET /videos/:publicId/download` de um vídeo `READY` retorna `302` cujo `Location` força o download como anexo.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(21) | unique, not null — `nanoid` (per phase-03-videos/TD-06), regenerate-on-conflict |
| channel_id | uuid | FK → `channel.id`, not null, on delete cascade (owner; from Phase 02) |
| title | varchar(255) | not null — fornecido no init do upload |
| status | enum(`DRAFT`, `PROCESSING`, `READY`, `ERROR`) | not null, default `DRAFT` (per phase-03-videos/TD-08) |
| original_key | varchar(512) | nullable — chave S3 `videos/{id}/original.<ext>` (per phase-03-videos/TD-02, TD-03) |
| content_type | varchar(127) | nullable — MIME informado no init |
| size_bytes | bigint | nullable — tamanho declarado no init (≤ 10GB) |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId` (per phase-03-videos/TD-03); limpo no complete |
| duration_seconds | int | nullable — extraído por `ffprobe` (per phase-03-videos/TD-05) |
| width | int | nullable — metadado de vídeo (ffprobe) |
| height | int | nullable — metadado de vídeo (ffprobe) |
| thumbnail_key | varchar(512) | nullable — chave S3 `videos/{id}/thumbnail.jpg` (per phase-03-videos/TD-05) |
| failure_reason | text | nullable — preenchido na transição para `ERROR` (per phase-03-videos/TD-08) |
| views_count | bigint | not null, default 0 — incrementado ao emitir URL de streaming (per phase-03-videos/TD-07) |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` (many-to-one via `channel_id`).
**Indexes:** unique on `public_id`; index on `channel_id`; index on `status` (consultas do worker e filtros de listagem futuros).
**Storage layout (per phase-03-videos/TD-02):** bucket único `videos`; chaves `videos/{id}/original.<ext>` e `videos/{id}/thumbnail.jpg` usando o `id` interno (uuid), nunca o `public_id` (evita vazar o identificador público no caminho de storage).
**Migration:** `CreateVideos` em `src/database/migrations/` (`synchronize: false`, per Inherited Conventions da Fase 01); cria o enum de status, a tabela e os índices.

### API Contracts

Todos os endpoints emitem erros no envelope `{ statusCode, error, message }` herdado da Fase 02 (per `## Inherited Conventions` — phase-02 TD-07) e são documentados com `@nestjs/swagger` (per openapi-docs-nestjs TD-01..03). **Os bytes do arquivo nunca transitam pela API** (per phase-03-videos/TD-03, TD-07).

#### POST /videos (SI-03.4)

Inicia o upload: cria o rascunho (`DRAFT`), abre o multipart upload no storage e devolve as URLs presigned das partes. **Requer autenticação** (dono do canal).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — máx 255 caracteres
- contentType: string, required — MIME do arquivo (ex.: `video/mp4`)
- sizeBytes: integer, required — tamanho total do arquivo, máx 10737418240 (10GB)

**Response 201:**
- id: string (uuid)
- publicId: string — `nanoid` (per phase-03-videos/TD-06)
- status: string — `DRAFT`
- uploadId: string — `UploadId` do multipart (per phase-03-videos/TD-03)
- partSize: integer — tamanho de cada parte em bytes
- parts: array of `{ partNumber: integer, url: string }` — URLs presigned de `UploadPart`, uma por parte

**Error responses:**
- 401 (sem token / token inválido — guard global de JWT)
- 413 FILE_TOO_LARGE: quando `sizeBytes` excede 10GB
- 415 UNSUPPORTED_MEDIA_TYPE: quando `contentType` não é suportado
- 400 validation error: corpo fora do schema

---

#### POST /videos/:id/complete (SI-03.4)

Conclui o multipart upload com os ETags das partes, transiciona `DRAFT → PROCESSING` e enfileira o job de processamento (per phase-03-videos/TD-03, TD-08). **Requer autenticação** (dono do vídeo).

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array of `{ partNumber: integer, etag: string }`, required — todas as partes enviadas, em ordem

**Response 200:**
- id: string (uuid)
- publicId: string
- status: string — `PROCESSING`

**Error responses:**
- 401 (sem token / token inválido)
- 403 VIDEO_NOT_OWNED: quando o vídeo não pertence ao canal do usuário
- 404 VIDEO_NOT_FOUND: quando o `id` não existe
- 409 UPLOAD_ALREADY_COMPLETED: quando o vídeo não está em `DRAFT`
- 400 INVALID_UPLOAD_PARTS: quando `parts` está vazio/inconsistente com o multipart

---

#### GET /videos/:publicId (SI-03.7)

Devolve os metadados do vídeo e o status de processamento; usado tanto para a tela de player (Fase 05) quanto para o uploader acompanhar o processamento. **Anônimo** vê apenas vídeos `READY`; o dono vê qualquer status.

**Response 200:**
- publicId: string
- title: string
- status: string — `DRAFT | PROCESSING | READY | ERROR`
- durationSeconds: integer | null
- width: integer | null
- height: integer | null
- thumbnailUrl: string | null — URL presigned GET da thumbnail (per phase-03-videos/TD-07), `null` enquanto não `READY`
- viewsCount: integer

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente, ou vídeo não-`READY` solicitado por anônimo

---

#### GET /videos/:publicId/stream (SI-03.7)

Emite uma URL presigned GET e responde `302 Found` redirecionando para o storage, que serve `Range`/`206 Partial Content` nativamente (per phase-03-videos/TD-07). Incrementa `views_count` no momento da emissão. **Anônimo** permitido para vídeos `READY`.

**Response 302:**
- Location: URL presigned GET do objeto original (expiração curta)

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_NOT_READY: vídeo existe mas não está em `READY`

---

#### GET /videos/:publicId/download (SI-03.7)

Igual ao stream, porém a URL presigned inclui `response-content-disposition: attachment` para forçar o download (per phase-03-videos/TD-07). **Anônimo** permitido para vídeos `READY`.

**Response 302:**
- Location: URL presigned GET com `response-content-disposition: attachment`

**Error responses:**
- 404 VIDEO_NOT_FOUND: `publicId` inexistente
- 409 VIDEO_NOT_READY: vídeo existe mas não está em `READY`

#### Validation Rules — videos

- `title`: required, máx 255 caracteres
- `contentType`: required, MIME na allowlist de vídeo
- `sizeBytes`: required, inteiro positivo, ≤ 10737418240 (10GB)
- `parts[]`: required no complete, cada item com `partNumber` ≥ 1 e `etag` não-vazio

### Authorization Matrix

"Owner" = usuário autenticado dono do canal ao qual o vídeo pertence. Rotas autenticadas usam o guard global de JWT (per phase-02 TD-02); rotas públicas usam opt-out explícito. Anônimo pode assistir/baixar livremente vídeos `READY` (per CLAUDE.md — "Anonymous users can watch freely").

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ | ✓ |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| GET /videos/:publicId | ✓ (só `READY`) | ✓ (só `READY`) | ✓ (qualquer status) |
| GET /videos/:publicId/stream | ✓ (só `READY`) | ✓ (só `READY`) | ✓ (só `READY`) |
| GET /videos/:publicId/download | ✓ (só `READY`) | ✓ (só `READY`) | ✓ (só `READY`) |

### Error Catalog

Emitidos pelo filtro de exceção de domínio herdado (envelope `{ statusCode, error, message }`, per phase-02 TD-07). Códigos novos desta fase:

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `publicId`/`id` inexistente, ou vídeo não-`READY` solicitado por anônimo |
| VIDEO_NOT_OWNED | 403 | Operação (complete) sobre vídeo de outro canal |
| UPLOAD_ALREADY_COMPLETED | 409 | `complete` chamado em vídeo que não está em `DRAFT` |
| INVALID_UPLOAD_PARTS | 400 | `parts` ausente ou inconsistente com o multipart no `complete` |
| VIDEO_NOT_READY | 409 | `stream`/`download` de vídeo que não está em `READY` |
| FILE_TOO_LARGE | 413 | `sizeBytes` excede 10GB no init |
| UNSUPPORTED_MEDIA_TYPE | 415 | `contentType` fora da allowlist de vídeo no init |

**Falha de processamento (assíncrona, não-HTTP):** quando o `ffmpeg`/`ffprobe` falha após esgotar as tentativas da fila, o vídeo transiciona para `ERROR` e `failure_reason` é persistido (per phase-03-videos/TD-08); ver `### Events/Messages`. Não é uma resposta HTTP — é estado consultável via `GET /videos/:publicId`.

### Events/Messages

#### video-processing (job de fila BullMQ)

**Payload:**

```json
{ "videoId": "uuid", "originalKey": "videos/{id}/original.<ext>" }
```

**Producer:** `VideosService` / queue producer (per phase-03-videos/TD-01, TD-03) — enfileira no `POST /videos/:id/complete`, após concluir o multipart e transicionar para `PROCESSING`.
**Consumer:** `VideoProcessingConsumer` no serviço `video-worker` (per phase-03-videos/TD-04, TD-05) — `ffprobe` extrai duração/metadados; `ffmpeg` extrai um frame para a thumbnail; faz upload da thumbnail; persiste metadados e transiciona `PROCESSING → READY`.
**Trigger:** conclusão do upload multipart (`complete`).
**Delivery semantics:** at-least-once — `attempts: 3` com `backoff` exponencial (per phase-03-videos/TD-01, TD-08). Ao esgotar as tentativas, o handler `failed` transiciona o vídeo para `ERROR` e persiste `failure_reason`; o job pode ser re-enfileirado para reprocessar. Conexão Redis pelo nome do serviço Compose (`redis`), nunca `localhost`.

---

## Dependency Map

```
SI-03.1 (root — entidade Video + migration)
SI-03.2 (root — infra: Redis, MinIO, config)
├── SI-03.3 — depends on SI-03.2 (storage adapter precisa da config S3 + MinIO)
└── SI-03.4 — depends on SI-03.2 (fila precisa do Redis + queue config)

SI-03.5 — depends on SI-03.1, SI-03.3, SI-03.4 (endpoints de upload: entidade + storage + producer)
SI-03.6 — depends on SI-03.1, SI-03.3, SI-03.4 (worker: entidade + storage + fila)
SI-03.7 — depends on SI-03.1, SI-03.3, SI-03.5 (entrega: entidade + storage + controller)
```

---

## Deliverables

- [ ] SI-03.1 — Modelar entidade Video + migration
- [ ] SI-03.2 — Infra: Redis, MinIO e configuração validada
- [ ] SI-03.3 — Adapter de object storage (S3/MinIO)
- [ ] SI-03.4 — Fila de processamento + producer
- [ ] SI-03.5 — Endpoints de upload (handshake DRAFT → PROCESSING)
- [ ] SI-03.6 — Worker de vídeo + pipeline ffmpeg
- [ ] SI-03.7 — Entrega: streaming e download

**Full test suites:**

- [ ] Backend (unit + integration) passa (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E passa (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)
