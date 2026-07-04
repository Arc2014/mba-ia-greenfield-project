# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express). Contains modules for users, channels, videos, comments, etc.
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` (Next.js) — not yet initialized

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST, streams from Object Storage
- **API** (Nest.js) → business rules, auth, reads/writes DB, uploads to storage, publishes jobs to queue, sends emails
- **Video Worker** (FFmpeg) → consumes jobs from queue, processes videos, updates DB and storage
- **Database** (PostgreSQL) → users, channels, videos, comments, likes
- **Object Storage** (S3/MinIO) → video files and thumbnails
- **Message Queue** (Redis + BullMQ) → video processing job queue
- **Email Service** (SMTP) → account confirmation and password recovery

## Videos (Phase 03 — Upload & Processing)

The videos domain lives in `nestjs-project/src/videos/` (`VideosModule`) plus a dedicated worker process. Infra runs in Docker Compose: `redis` (queue), `minio` (S3-compatible storage), and `video-worker` (the FFmpeg consumer) alongside `db`/`mailpit`/`nestjs-api`.

**Upload strategy (up to 10GB, bytes never transit the API):** presigned S3 **multipart** direct-to-storage.
- `POST /videos` (authenticated, channel owner) — pre-registers the video as `DRAFT`, opens a multipart upload, returns `uploadId`, `partSize` and presigned `parts[]` URLs. The client PUTs each part directly to storage.
- `POST /videos/:id/complete` (owner) — completes the multipart upload with the part ETags, transitions `DRAFT → PROCESSING`, and enqueues a `video-processing` job.

**Processing (async):** the `video-worker` service (`src/worker.ts` → `WorkerModule`, a standalone Nest context registering the BullMQ `@Processor`) consumes the `video-processing` queue. It downloads the original, runs `ffprobe` (duration + dimensions) and `ffmpeg` (thumbnail frame → `videos/{id}/thumbnail.jpg`), persists the metadata, and transitions `PROCESSING → READY`. Retries follow BullMQ (`attempts: 3`, exponential backoff); once exhausted, the video goes to `ERROR` with `failure_reason`. The consumer is intentionally **not** part of `VideosModule`, so the API process never consumes the queue.

**Status lifecycle:** `DRAFT → PROCESSING → READY | ERROR`.

**Delivery (public; bytes stay off the API):**
- `GET /videos/:publicId` — metadata + presigned thumbnail URL. Anonymous/non-owners see only `READY`; the owner (optional JWT) sees any status.
- `GET /videos/:publicId/stream` — `302` redirect to a short-lived presigned GET (storage serves Range/206); increments `views_count`. `409 VIDEO_NOT_READY` if not `READY`.
- `GET /videos/:publicId/download` — `302` redirect to a presigned GET with `response-content-disposition: attachment`.

**Storage layout:** single bucket `videos`; keys `videos/{id}/original.<ext>` and `videos/{id}/thumbnail.jpg` (internal uuid, never the public id). **URL uniqueness:** each video has a `nanoid` `public_id` (unique column, regenerate-on-conflict).

**Persistence:** the `videos` table (migration `CreateVideos`) — entity `Video` belongs to `Channel` (many-to-one, on delete cascade); columns include `public_id`, `status`, `original_key`, `thumbnail_key`, `duration_seconds`, `width`/`height`, `views_count`, `failure_reason`.

Running the worker locally: `docker compose exec video-worker npm run start:worker:dev` (the Compose service also starts it automatically). See `nestjs-project/CLAUDE.md` for the worker/test caveats.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->
