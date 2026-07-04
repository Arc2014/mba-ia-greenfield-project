# phase-03-videos — Progress

**Status:** completed
**SIs:** 7/7 completed

### SI-03.1 — Modelar entidade Video + migration
- **Status:** completed
- **Tests:** 6 passing (4 entity constraints + 2 migration run/revert)
- **Observations:**
  - Cobertura dividida em 2 arquivos (em vez do único arquivo listado no plano): `video.entity.integration-spec.ts` (defaults, unique public_id, cascade, bigint round-trip) + extensão de `migrations.integration-spec.ts` para o run/revert do `CreateVideos` — respeita a convenção do projeto de um spec de migrations dedicado.
  - Corrigida fragilidade pré-existente em `migrations.integration-spec.ts`: o `beforeAll` dropava tabelas em paralelo (`Promise.all`), o que dá deadlock quando a FK videos→channels entra em cena; agora dropa em série e também dropa os enum types.
  - `created_at`/`updated_at` usam `TIMESTAMP` (default do `@CreateDateColumn` do projeto), não `timestamptz` como o Data Model dizia — seguida a convenção do projeto.
  - `size_bytes`/`views_count` (bigint) expostos como `number` via `ValueTransformer` (valores < 2^53).
  - **Setup de ambiente (fora do escopo do código do SI):** criado `nestjs-project/.env` (ausente); remapeada a porta do host do `db` em `compose.yaml` de `5432`→`5434` por conflito com um container `postgres` de outro projeto (o app usa `db:5432` na rede interna, então não é afetado). Decisão de versionar essas mudanças é do usuário.

### SI-03.2 — Infra: Redis, MinIO e configuração validada
- **Status:** completed
- **Tests:** no tests (Infra); `env.validation.integration-spec.ts` atualizado e verde (4 passing)
- **Observations:**
  - `redis` e `minio` adicionados ao compose **sem mapeamento de porta no host** (acesso só interno via nomes de serviço `redis:6379` / `minio:9000`) — evita conflitos de porta no host como o do `db`.
  - `minio` sem healthcheck (a imagem server não traz curl/mc); serviços dependentes usarão `service_started` e o `StorageService` (SI-03.3) garante/cria o bucket no init.
  - Joi agora exige `S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`REDIS_HOST`; vars adicionadas a `.env` e `.env.example`; `requiredEnv` do `env.validation.integration-spec.ts` atualizado para manter o teste verde.
  - AC "containers sobem" não verificada fisicamente neste SI (subida do redis/minio adiada a pedido do usuário); será exercitada no SI-03.3 quando o teste de storage subir o MinIO.

### SI-03.3 — Adapter de object storage (S3/MinIO)
- **Status:** completed
- **Tests:** 3 passing (multipart round-trip presigned, contentDisposition, abort) contra MinIO real
- **Observations:**
  - Bucket garantido de forma lazy/memoizada (sem `onModuleInit`) — mantém o boot da app e os e2e não-relacionados desacoplados do MinIO; o bucket é criado no primeiro `createMultipartUpload`.
  - MinIO subido nesta etapa; confirma de fato a AC1 do SI-03.2 (containers sobem).
  - Instalados `@aws-sdk/client-s3@^3.1076.0` e `@aws-sdk/s3-request-presigner@^3.1076.0`.

### SI-03.4 — Fila de processamento + producer
- **Status:** completed
- **Tests:** 2 passing (payload videoId/originalKey; attempts=3 + backoff exponential) contra BullMQ + Redis reais
- **Observations:**
  - `defaultJobOptions` (attempts 3, backoff exponencial, removeOnComplete/removeOnFail) extraídos para `VIDEO_PROCESSING_JOB_OPTIONS` em `video-processing.constants.ts` — fonte única compartilhada entre o `registerQueue` do módulo e o teste.
  - Instalados `bullmq@^5.79.2` e `@nestjs/bullmq@^11.0.4`; Redis subido.

### SI-03.5 — Endpoints de upload (handshake DRAFT → PROCESSING)
- **Status:** completed
- **Tests:** 14 passing (8 unit em `videos.service.spec.ts` cobrindo init/complete + guardas de tamanho/tipo/ownership/estado; 6 e2e em `videos-upload.e2e-spec.ts` exercitando o handshake real via HTTP contra Postgres + MinIO + Redis)
- **Observations:**
  - Código já existia no working tree (implementado numa sessão anterior que encerrou antes de rodar os testes); esta sessão verificou-o inteiro contra o plano e a spec `videos-upload.plan.md`, subiu a infra e rodou as suítes — ambas verdes, sem alterações necessárias.
  - `partSize` fixo em 100MB (`UPLOAD_PART_SIZE_BYTES`), acima do mínimo de 5MB do S3; `MAX_VIDEO_SIZE_BYTES = 10GB` aplicado no `initUpload` antes de tocar no storage.
  - DTOs de request usam `@ApiProperty` explícito em vez de JSDoc+plugin (convenção de `nestjs-dtos.md` prefere JSDoc para request DTOs) — funciona e passa lint/tsc; alinhamento à convenção fica como follow-up cosmético fora do escopo do SI.

### SI-03.6 — Worker de vídeo + pipeline ffmpeg
- **Status:** completed
- **Tests:** 4 passing (2 `ffmpeg.service.integration-spec.ts` — probe de duração/dimensões + extração de thumbnail com ffmpeg/ffprobe reais sobre fixture lavfi; 2 `video-processing.consumer.integration-spec.ts` — job fim-a-fim via BullMQ/Redis + MinIO + ffmpeg reais levando o vídeo a READY com metadados/thumbnail, e caminho de falha com `attempts:1` levando a ERROR com `failure_reason`)
- **Observations:**
  - **Isolamento do consumer:** o `VideoProcessingConsumer` (`@Processor`) vive num `WorkerModule` enxuto próprio (`src/worker/worker.module.ts`, bootstrap em `src/worker.ts` via `NestFactory.createApplicationContext`), **não** no `VideosModule` — assim o processo da API nunca inicia um worker de fila; só o serviço `video-worker` consome. O `WorkerModule` reusa os factories de config (database/queue/storage), a entidade e as constantes da fila; precisa registrar `Video` + entidades relacionadas (`Channel`, `User`, `RefreshToken`, `VerificationToken`) no `forFeature` para o TypeORM montar o grafo de metadados (senão `autoLoadEntities` não resolve `Video#channel`).
  - **ffmpeg na imagem:** adicionado `ffmpeg` ao `Dockerfile.dev` (imagem compartilhada API+worker, per TD-04); imagem rebuildada e `nestjs-api` recriado (os integration specs rodam dentro do `nestjs-api`, que também precisa do binário).
  - **Serviço `video-worker` no compose:** mesma imagem, `command: npm run start:worker:dev` (auto-executa o consumer em watch). Verificado subindo e logando `[VideoWorker] Consuming the video-processing queue`. Durante execução dos testes ele é **parado** (`docker compose stop video-worker`) para não roubar jobs — o que quebraria o determinismo do consumer spec e a asserção `getWaiting` do e2e de upload (SI-03.5). É um serviço de runtime, não parte do harness de teste.
  - **StorageService** ganhou `getObjectStream` (download em stream, sem bufferizar 10GB) e `putObject` (upload da thumbnail) — consumidos só pelo worker; adicionados neste SI.
  - Timestamp da thumbnail: frame em `min(1, duração/2)`s para tolerar vídeos muito curtos; chave `videos/{id}/thumbnail.jpg` usando o uuid interno (per Data Model).

### SI-03.7 — Entrega: streaming e download
- **Status:** completed
- **Tests:** 11 passing (6 unit novos em `videos.service.spec.ts` — watch info READY, ocultar não-READY de anônimo, revelar não-READY ao dono, incremento de views no stream, VideoNotReady no stream, download com disposition attachment; 5 e2e em `videos-delivery.e2e-spec.ts` cobrindo os 5 ACs de entrega contra Postgres + MinIO reais)
- **Observations:**
  - **Auth opcional em rota pública:** `GET /videos/:publicId` é `@Public()` (anônimo pode ver `READY`) mas usa `@UseGuards(OptionalJwtAuthGuard)` — novo guard em `src/auth/guards/optional-jwt-auth.guard.ts` que popula `request.user` se houver Bearer válido e nunca rejeita. Assim o dono vê qualquer status. Guard provido/exportado pelo `AuthModule`; `VideosModule` passou a importar `AuthModule` (que exporta `JwtModule` + o guard).
  - **Redirect sem bytes na API:** `/stream` e `/download` usam `@Redirect()` retornando `{ url, statusCode: 302 }` com URL presigned; storage serve Range/206 nativamente (per TD-07). `/download` presigna com `response-content-disposition=attachment`.
  - **Views atômico:** `getStreamRedirect` usa `repository.increment({ id }, 'views_count', 1)` (incremento no SQL, sem read-modify-write) e só conta view em vídeo `READY`.
  - Vídeo não-`READY` para anônimo retorna `404 VIDEO_NOT_FOUND` (não vaza existência); `/stream` e `/download` de não-`READY` retornam `409 VIDEO_NOT_READY`.
