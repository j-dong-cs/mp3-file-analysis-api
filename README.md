# mp3-file-analysis-api

A **NestJS** API that counts the audio frames of an MP3. Small files are **streamed and counted
in-request**; large files are **offloaded to an async pipeline** (object storage + job queue +
worker) — all behind a single `POST /file-upload` endpoint. The frame counter is hand-written
(no MP3-parsing library) and streaming, so memory is **O(1)** regardless of file size.

> Scope: MPEG Version 1, Audio Layer III (the standard `.mp3` format). Other MPEG versions/layers
> are intentionally out of scope, so the header decoder accepts only MPEG-1 Layer III frames.

## API contract

### `POST /file-upload`

One MP3 as `multipart/form-data`, field name `file`. The endpoint picks a strategy from the
request's `Content-Length`:

| Upload size | Strategy | Response |
| ----------- | -------- | -------- |
| ≤ `MAX_UPLOAD_BYTES` (25 MB) | stream + count in-request | **200** `{ "frameCount": <number> }` |
| > 25 MB (or unknown length) | stream to storage + enqueue job | **202** `{ uploadId, status, statusUrl }` |

Errors: **400** (no file part) · **413** (exceeds the async cap) · **415** (not multipart / not an
MP3) · **422** (no valid frames).

### `GET /file-upload/:id`

Poll an async upload's result → `{ id, status, frameCount, errorMessage }`
(`status`: `pending | processing | done | failed`). **404** if unknown.

```bash
# small file → immediate count
curl -F "file=@sample.mp3" http://localhost:3000/file-upload
# {"frameCount":6089}

# large file → accepted, then poll
curl -F "file=@big.mp3" http://localhost:3000/file-upload
# {"uploadId":"…","status":"pending","statusUrl":"/file-upload/…"}
curl http://localhost:3000/file-upload/<uploadId>
# {"id":"…","status":"done","frameCount":123456,"errorMessage":null}
```

## Architecture

```
                       POST /file-upload
                              │ branch on Content-Length
             ┌────────────────┴─────────────────┐
        small│(sync)                       large │(async)
             ▼                                   ▼
   FileUploadService                     FileAnalysisService.acceptLargeUpload
   busboy → counter.feed()               busboy → stream to MinIO (S3)
             │                           create row (Postgres) → enqueue (BullMQ/Redis)
             ▼                                   │ 202 { uploadId }
      200 { frameCount }                         ▼
                                        Mp3AnalysisProcessor (worker)
                                        getObjectStream(S3) → counter.feed() → DB done
                                                 ▲
                                        GET /file-upload/:id  ← client polls
```

Both paths use the **same** `StreamingFrameCounter` (via `Mp3AnalyzeService.createFrameCounter()`).
The `mp3/` core is framework-agnostic, which is exactly why the worker reuses it unchanged.

### Why this shape
- **Small files** (the common case, incl. the assessment sample) get an instant `{ frameCount }`.
- **Large files** don't tie up a request for a long transfer; the parse runs off the request path
  on a worker, so the API stays fast and **workers scale horizontally** (see below).
- The parser itself is O(1) memory for any size — async is about *operational* scaling
  (connection duration, worker fan-out), not the parser's ability.

## How frame counting works

The counter is a streaming state machine (`StreamingFrameCounter`) fed one chunk at a time
(`feed()` / `finalize()`), so memory stays **O(1)** regardless of file size:

1. **Skip a leading ID3v2 tag** if present — the tag declares its own (synchsafe) size.
2. **Find the frame sync** (`0xFF`, `0xE0` mask) and decode the 4-byte header via fixed lookup
   tables → **frame length**.
3. **Skip the VBR header frame** — the first frame may be a Xing/Info/VBRI metadata frame rather
   than audio; it's excluded so the count matches `mediainfo`.
4. **Hop to the next header** by the frame length, incrementing the count; only 4-byte headers are
   inspected, payload is skipped (never buffered).
5. **Stop** at the first non-frame bytes after the audio (e.g. a trailing ID3v1 `TAG`).

## Performance

Measured locally (Apple Silicon; MinIO/Redis/Postgres in Docker):

| Scenario | Result |
| -------- | ------ |
| Sync count, 1.46 MB sample (`POST /file-upload`) | ~**3–4 ms** end-to-end |
| Parse a **1 GB** MP3 (streaming counter, read from disk) | ~**0.68 s** · ~**1.5 GB/s** · **92 MB** peak RSS |
| Memory footprint | **flat / O(1)** — ~unchanged from 128 MB to 1 GB (`npm run test:bench`) |

The parse is CPU-cheap — it reads only the 4-byte headers and hops over payload — so large-file
latency is dominated by **byte transfer**, not counting. That's exactly why the async pipeline
exists: to move the transfer off the request path, not to speed up the (already fast) parse.

## Verification & correctness

Frame counts are validated against `mediainfo`; on real files they agree — e.g. the sample MP3
reports **6089** from both.

> **`mediainfo`'s CBR "Frame count" is a *calculation*, not an actual count.** For a
> constant-bitrate file it derives the frame count from the *duration*
> (`fileSize × 8 ÷ bitrate ÷ frame-duration`) — a bitrate-based estimate. This counter instead
> **walks and counts every frame**. They match on properly-encoded files (whose padding makes the
> average frame size equal the nominal bitrate), but can differ on a synthetic stream of *unpadded*
> frames: a hand-built 1 GB file of exactly-417-byte frames truly contains **2,582,400** frames
> (what this counter returns), while `mediainfo` *estimates* 2,576,474 from the nominal 128 kbps.
> Counting is the precise measure; the estimate only coincides when the encoder's padding averages
> out to the nominal bitrate.

## Structure

```
src/
├── main.ts                       # bootstrap
├── app.module.ts                 # composition root
├── config/configuration.ts       # typed env config (server, S3, Redis, DB, thresholds)
├── common/                       # FileValidator + MP3_FIELD_NAME (shared by both paths)
├── database/                     # DatabaseModule — the Postgres connection (isolated seam)
├── storage/                      # StorageService — S3 client → MinIO
├── mp3/                          # framework-agnostic streaming counter + pure helpers
├── file-upload/                  # POST /file-upload controller + sync FileUploadService
└── file-analysis/                # async pipeline
    ├── entities/file-upload.entity.ts   # FileUpload (file_uploads table)
    ├── file-analysis.service.ts         # accept→S3→enqueue · processUpload · status
    ├── mp3-analysis.processor.ts        # BullMQ @Processor (the worker)
    └── file-analysis.module.ts          # entity + queue + worker wiring
test/
├── app.e2e-spec.ts               # endpoint e2e — both branches (needs the stack)
├── *.integration-spec.ts         # storage / processing / queue (needs the stack)
├── jest-e2e.json · jest-integration.json
docker-compose.yml                # MinIO (S3) + Redis + Postgres
```

## Getting started

The app is now DB/queue-backed, so the local stack must be running:

```bash
npm install
docker compose up -d          # MinIO(:9000/:9001), Redis(:6379), Postgres(:5432)
cp .env.example .env          # optional; sensible defaults match docker-compose.yml
npm run start:dev             # → http://localhost:3000
```

TypeORM `synchronize` (dev-only, env-gated) auto-creates the `file_uploads` table on boot.
Tear down: `docker compose down -v`.

## Configuration

Loaded once at startup via `@nestjs/config`, with defaults matching `docker-compose.yml`.

| Var | Default | Purpose |
| --- | ------- | ------- |
| `PORT` | `3000` | HTTP port |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MB) | **Sync/async threshold** + sync-path cap |
| `MAX_ASYNC_UPLOAD_BYTES` | `5368709120` (5 GB) | Absolute cap for the async path (→ 413) |
| `S3_*` | MinIO local | Object storage (endpoint, bucket, keys, `forcePathStyle`) |
| `REDIS_*` | localhost:6379 | BullMQ backing store |
| `DB_*` | localhost:5432 | Postgres; `DB_SYNCHRONIZE` (dev only) |

## Testing

**45 automated tests.** See the full **[testing plan](docs/TESTING.md)** for strategy, coverage
by area, and the backlog.

| Tier | Command | Tests | Needs stack? |
| ---- | ------- | :---: | :----------: |
| Unit — counter, helpers, factory | `npm test` | 26 | no (hermetic) |
| Integration — storage, processing, rollback, queue→worker→DB, scaling | `npm run test:integration` | 9 | **yes** |
| E2e — endpoint, both branches + all error paths + concurrency | `npm run test:e2e` | 9 | **yes** |
| Bench — memory O(1) proof (streams 1 GB) | `npm run test:bench` | 1 | no |

Highlights: the counter's **O(1) memory** (1 GB → ~0 MB growth), **horizontal scaling** (N workers
evenly drain a job queue), and **concurrency isolation** (parallel uploads never cross-contaminate)
are each backed by a test.

## Scaling: horizontal workers

The async worker is a thin BullMQ `@Processor` over the tested `processUpload`. Run **multiple app
instances** against the same Redis and BullMQ distributes analysis jobs across their workers, with
retries/failover — reusing the one `StreamingFrameCounter` throughout.

```bash
# 3 instances sharing the stack (different ports); each is API + worker
PORT=3000 node dist/main.js &
PORT=3001 node dist/main.js &
PORT=3002 node dist/main.js &
# upload many files → the queue fans the jobs out across all three workers
```

Production would swap MinIO→S3, add presigned direct-to-S3 uploads (true transfer offload), and run
the worker as its own deployment — all config/deployment changes, not parser changes.

## Scripts

| Script | Description |
| ------ | ----------- |
| `npm run start:dev` / `start:prod` | Nest dev (watch) / compiled |
| `npm run build` · `npm run typecheck` | Compile · `tsc --noEmit` |
| `npm run lint` · `npm run format` | ESLint (`--fix`) · Prettier |
| `npm test` · `test:e2e` · `test:integration` | Unit · endpoint e2e · infra integration |
| `npm run test:bench` · `test:cov` | Memory O(1) benchmark · coverage |
