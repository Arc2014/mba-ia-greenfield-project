---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: test/videos-upload.e2e-spec.ts
---

# Upload de Vídeos (handshake) — Test Plan

## Application Overview

O handshake de upload da Fase 03 expõe dois endpoints. `POST /videos` (autenticado) pré-cadastra o vídeo como rascunho (`DRAFT`), abre um multipart upload no object storage e devolve as URLs presigned das partes — sem que os bytes do arquivo passem pela API. `POST /videos/:id/complete` (apenas o dono) conclui o multipart com os ETags das partes, transiciona o vídeo para `PROCESSING` e enfileira o job de processamento. Estes testes e2e exercitam o ciclo completo via HTTP real, com PostgreSQL e MinIO reais do Compose.

## Test Scenarios

### 1. Iniciar upload (POST /videos)

**Setup:** beforeEach trunca as tabelas de teste e faz bootstrap do módulo NestJS (`Test.createTestingModule(...).compile()` + `app.init()`); um canal autenticado (usuário + token JWT) é semeado como fixture.

#### 1.1. init-upload-sucesso

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `POST /videos` com `Authorization: Bearer <token>` e body `{ title, contentType: "video/mp4", sizeBytes: 104857600 }`.
    - expect: status `201`.
    - expect: corpo contém `publicId` (string), `uploadId` (string), `partSize` (inteiro) e `parts[]` com `{ partNumber, url }`.
    - expect: existe no banco um `Video` com aquele `publicId`, `status = "DRAFT"` e `channel_id` do usuário autenticado.

#### 1.2. init-upload-arquivo-grande-demais

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `POST /videos` autenticado com body cujo `sizeBytes` excede 10737418240 (10GB).
    - expect: status `413`.
    - expect: corpo no envelope `{ statusCode, error, message }` com `error: "FILE_TOO_LARGE"`.
    - expect: nenhum `Video` é criado no banco.

#### 1.3. init-upload-sem-autenticacao

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `POST /videos` sem header `Authorization`.
    - expect: status `401`.
    - expect: nenhum `Video` é criado no banco.

### 2. Concluir upload (POST /videos/:id/complete)

**Setup:** além do bootstrap da seção 1, semeia um `Video` em `DRAFT` pertencente ao canal autenticado, com um `upload_id` de multipart válido no MinIO.

#### 2.1. complete-upload-sucesso

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. Enviar as partes do arquivo para as URLs presigned e coletar os ETags.
  2. `POST /videos/:id/complete` autenticado (dono) com body `{ parts: [{ partNumber, etag }] }`.
    - expect: status `200`.
    - expect: corpo contém `status: "PROCESSING"`.
    - expect: o `Video` no banco está em `PROCESSING` e um job foi enfileirado em `video-processing` com `videoId` no payload.

#### 2.2. complete-upload-nao-dono

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `POST /videos/:id/complete` autenticado por um usuário cujo canal NÃO é dono do vídeo.
    - expect: status `403`.
    - expect: corpo com `error: "VIDEO_NOT_OWNED"`.
    - expect: o `Video` permanece em `DRAFT` e nenhum job é enfileirado.

#### 2.3. complete-upload-estado-invalido

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. Semear um `Video` do dono que já está em `PROCESSING` (não-`DRAFT`).
  2. `POST /videos/:id/complete` autenticado (dono) nesse vídeo.
    - expect: status `409`.
    - expect: corpo com `error: "UPLOAD_ALREADY_COMPLETED"`.
