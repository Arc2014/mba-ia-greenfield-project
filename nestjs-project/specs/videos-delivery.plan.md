---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-delivery.e2e-spec.ts
---

# Entrega de Vídeos (streaming e download) — Test Plan

## Application Overview

A entrega da Fase 03 expõe a leitura pública do vídeo. `GET /videos/:publicId` devolve os metadados e o status de processamento (anônimo vê apenas vídeos `READY`; o dono vê qualquer status). `GET /videos/:publicId/stream` emite uma URL presigned GET e responde `302`, delegando o `Range`/`206` ao storage e incrementando a contagem de views. `GET /videos/:publicId/download` faz o mesmo, mas com `response-content-disposition: attachment`. Em nenhum caso os bytes transitam pela API. Estes testes e2e exercitam os três endpoints via HTTP real contra PostgreSQL e MinIO do Compose.

## Test Scenarios

### 1. Metadados do vídeo (GET /videos/:publicId)

**Setup:** beforeEach trunca as tabelas de teste e faz bootstrap do módulo NestJS (`Test.createTestingModule(...).compile()` + `app.init()`); fixtures semeiam vídeos em estados `READY` e `PROCESSING`.

#### 1.1. metadados-video-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `GET /videos/:publicId` (anônimo) de um vídeo `READY`.
    - expect: status `200`.
    - expect: corpo contém `status: "READY"`, `durationSeconds`, `width`, `height`, `thumbnailUrl` (string presigned) e `viewsCount`.

#### 1.2. metadados-video-nao-ready-anonimo

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `GET /videos/:publicId` (anônimo) de um vídeo em `PROCESSING`.
    - expect: status `404`.
    - expect: corpo no envelope `{ statusCode, error, message }` com `error: "VIDEO_NOT_FOUND"`.

### 2. Streaming (GET /videos/:publicId/stream)

**Setup:** idem seção 1; um vídeo `READY` com objeto original disponível no MinIO é semeado.

#### 2.1. stream-video-ready

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. Ler o `views_count` atual do vídeo `READY`.
  2. `GET /videos/:publicId/stream` (anônimo), sem seguir o redirect.
    - expect: status `302`.
    - expect: header `Location` aponta para uma URL presigned GET do objeto original.
    - expect: o `views_count` do vídeo no banco foi incrementado em 1.

#### 2.2. stream-video-nao-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `GET /videos/:publicId/stream` de um vídeo em `PROCESSING`.
    - expect: status `409`.
    - expect: corpo com `error: "VIDEO_NOT_READY"`.
    - expect: o `views_count` não é alterado.

### 3. Download (GET /videos/:publicId/download)

**Setup:** idem seção 2.

#### 3.1. download-video-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-06-30T17:21:52Z

**Steps:**
  1. `GET /videos/:publicId/download` (anônimo) de um vídeo `READY`, sem seguir o redirect.
    - expect: status `302`.
    - expect: header `Location` aponta para uma URL presigned GET cujo `response-content-disposition` força o download como anexo (`attachment`).
