# mp3-file-analysis-api

A **NestJS** API that accepts an MP3 upload and returns its audio frame count. The file is
**streamed and parsed while it uploads** (never fully buffered); the frame counter is
hand-written (no MP3-parsing library).

> Scope: MPEG Version 1, Audio Layer III (the standard `.mp3` format). Other MPEG versions/layers
> are intentionally out of scope, so the header decoder accepts only MPEG-1 Layer III frames.

## Current state

- **Endpoint implemented & working.** `POST /file-upload` streams the upload, counts frames, and
  returns `{ frameCount }`, with full error mapping (400 / 413 / 415 / 422).
- **Parsing core implemented & unit-tested.** Streaming frame counter + pure helpers
  (frame-header decode, ID3v2 skip, VBR/Xing header detection). **26 unit tests** cover
  chunk-boundary invariance, VBR/padding, ID3v2 (incl. split across chunks), leading-garbage
  resync, trailing tags, the Xing-header exclusion, and the empty/no-frame (422) cases.
- **End-to-end tested.** 6 e2e tests exercise the real endpoint (200 + 400/413/415/422).
- **Local infra scaffolded (groundwork).** `docker-compose.yml` provides MinIO (S3), Redis, and
  PostgreSQL, and `configuration.ts` has typed config for them — prep for the planned async
  large-file pipeline (see [Scaling](#scaling-planned)). **Not yet wired into the app.**

## API contract

`POST /file-upload` — one MP3 as `multipart/form-data`, field name `file`.

- **200** → `{ "frameCount": <number> }`
- Errors → **400** (no file part) · **413** (too large) · **415** (not multipart / not an MP3) · **422** (no valid frames)

```bash
curl -F "file=@sample.mp3" http://localhost:3000/file-upload
# {"frameCount":42}
```

## Request workflow

```
POST /file-upload
  → FileUploadController   # @Req() raw request (streaming, not FileInterceptor)
  → FileValidator          # content-type (415) + size limit (413, mid-stream)
  → FileUploadService      # busboy stream → counter.feed(chunk); settle-once
  → Mp3AnalyzeService      # createFrameCounter — per-upload state machine
  → { frameCount }
```

## How frame counting works

The counter is a streaming state machine (`StreamingFrameCounter`) fed one chunk at a time
(`feed()` / `finalize()`), so memory stays **O(1)** regardless of file size:

1. **Skip a leading ID3v2 tag** if present — the tag declares its own (synchsafe) size, so we jump it.
2. **Find the frame sync** (11 set bits: `0xFF`, `0xE0` mask) and decode the 4-byte header
   (version/layer/bitrate/sample-rate/padding) via fixed lookup tables → **frame length**.
3. **Skip the VBR header frame** — the first frame may be a Xing/Info/VBRI metadata frame rather
   than audio; it's detected and excluded so the count matches tools like `mediainfo`.
4. **Hop to the next header** by the frame length, incrementing the count; only the 4-byte headers
   are inspected, payload is skipped (never buffered).
5. **Stop** at the first non-frame bytes after the audio (e.g. a trailing ID3v1 `TAG`).

Only unconsumed bytes at a chunk boundary (a partial header, or the remainder of a frame being
skipped) are carried between chunks — never the whole file.

## Structure

```
src/
├── main.ts                          # bootstrap (port via ConfigService)
├── app.module.ts                    # root module (global config)
├── config/configuration.ts          # typed env config (server, S3, Redis, DB)
├── file-upload/
│   ├── file-upload.module.ts        # DI wiring
│   ├── file-upload.controller.ts    # POST /file-upload
│   ├── file.validator.ts            # type checks (415) + maxBytes for size limit (413)
│   └── file-upload.service.ts       # busboy streaming into the frame counter
└── mp3/
    ├── mp3-analyze.service.ts       # createFrameCounter factory
    ├── frame-counter.ts             # StreamingFrameCounter (feed / finalize)
    ├── frame-header-helper.ts       # pure MPEG-1 Layer III header decode + tables
    ├── id3-tag-helper.ts            # pure ID3v2 tag-size reader
    ├── vbr-header-helper.ts         # Xing/Info/VBRI header-frame detection
    ├── frame-counter.spec.ts        # counter unit tests
    ├── mp3-analyze.service.spec.ts  # service (factory) unit tests
    └── testing/mp3-fixtures.ts      # synthetic MP3 builders for tests
test/
├── app.e2e-spec.ts                  # endpoint e2e (200 / 400 / 413 / 415 / 422)
└── jest-e2e.json
docker-compose.yml                   # MinIO (S3) + Redis + Postgres — local infra (groundwork)
.env.example                         # documented env vars
```

The `mp3/` core is **framework-agnostic** (no `@nestjs` imports outside the thin service), so the
same counter can be reused by an async worker reading from object storage.

## Getting started

```bash
npm install
cp .env.example .env        # optional; sensible defaults are built in
npm run start:dev           # → http://localhost:3000
```

The API runs standalone — no external services are required for `POST /file-upload` today.
Optionally start the local infra (only needed once the async pipeline is wired):

```bash
docker compose up -d        # MinIO(:9000/:9001), Redis(:6379), Postgres(:5432)
docker compose down -v      # stop and wipe volumes
```

## Configuration

Config is loaded once at startup via `@nestjs/config` (`configuration.ts`), with defaults that match
`docker-compose.yml`. Key vars (see `.env.example` for the full list):

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3000` | HTTP port |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MiB) | Upload cap (→ 413) |
| `S3_*`, `REDIS_*`, `DB_*` | local stack | Groundwork for the async pipeline (unused today) |

## Scripts

| Script | Description |
| ------ | ----------- |
| `npm run start:dev` | Nest dev server (watch) |
| `npm run build` / `npm run start:prod` | Build / run compiled |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (`--fix`) |
| `npm run format` | Prettier write |
| `npm test` / `test:watch` / `test:cov` | Jest unit tests |
| `npm run test:e2e` | Jest e2e (endpoint) |

## Scaling (planned)

For very large files and high request volume, the synchronous endpoint would give way to an async
pipeline (infra for this is already scaffolded in `docker-compose.yml`):

1. Client requests a presigned URL; API returns an `uploadId` and uploads directly to object storage
   (S3/MinIO), bypassing the API.
2. Upload completion enqueues a job (BullMQ/Redis).
3. A worker streams the object through the **same** `StreamingFrameCounter` (O(1) memory) and writes
   `{ frameCount }` to Postgres.
4. Client polls status (or is notified) and reads the result.

The framework-agnostic `mp3/` core is designed so the worker reuses the counter unchanged.
