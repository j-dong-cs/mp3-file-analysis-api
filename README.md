# mp3-file-analysis-api

A **NestJS** API that counts the audio frames of an MP3. Small files are **streamed and counted
in-request**; large files are **offloaded to an async pipeline** (object storage + job queue +
worker) — all behind a single `POST /file-upload` endpoint. The frame counter is hand-written
(no MP3-parsing library) and streaming, so memory is **O(1)** regardless of file size.

> Scope: MPEG Version 1, Audio Layer III (the standard `.mp3` format). Other MPEG versions/layers
> are intentionally out of scope, so the header decoder accepts only MPEG-1 Layer III frames.

## Run and Test Steps:

### 1. Start the infra

```bash
cd mp3-file-analysis-api        # after: git clone <repo-url>
docker compose up -d           # MinIO(:9000/:9001), Redis(:6379), Postgres(:5432)
docker compose ps              # wait until all show "healthy"
```

### 2. Run the API (this instance also runs the worker)

```bash
npm install                    # first time only
npm run start:dev              # → http://localhost:3000
# (or: npm run build && npm run start:prod)
```

### 3. Sync path — a small real file → instant count

```bash
SAMPLE=./sample.mp3            # drop the provided sample MP3 here (~1.46 MB, < 25 MB → sync)

curl -F "file=@$SAMPLE;type=audio/mpeg" http://localhost:3000/file-upload
# → {"frameCount":6089}

# with timing:
curl -s -w '\nhttp %{http_code} · %{time_total}s\n' \
  -F "file=@$SAMPLE" http://localhost:3000/file-upload
```

### 4. Async path — route the sample through the large-file pipeline

The sample is under the 25 MB threshold, so to exercise the async path either use a >25 MB file, or
just lower the threshold and restart the server:

```bash
# stop the server (Ctrl-C), then start with a tiny threshold so any upload goes async:
MAX_UPLOAD_BYTES=1000 npm run start:dev
```

Then upload → get a `202` + poll for the result:

```bash
SAMPLE=./sample.mp3

RESP=$(curl -s -F "file=@$SAMPLE" http://localhost:3000/file-upload)
echo "$RESP"
# → {"uploadId":"<id>","status":"pending","statusUrl":"/file-upload/<id>"}
ID=$(echo "$RESP" | jq -r .uploadId)       # (or copy the id by hand)
curl -s "http://localhost:3000/file-upload/$ID" | jq
# poll a couple times → {"id":"<id>","status":"done","frameCount":6089,"errorMessage":null}
```

### 5. Error cases (quick sanity)

```bash
curl -i -X POST -H 'Content-Type: application/json' -d '{}' http://localhost:3000/file-upload   # 415
curl -i -F "file=@README.md" http://localhost:3000/file-upload                                   # 415 (not an mp3)
curl -i -X POST -H 'Content-Type: multipart/form-data' --data 'garbage' http://localhost:3000/file-upload  # 400 (malformed)
curl -i http://localhost:3000/file-upload/00000000-0000-0000-0000-000000000000                   # 404
```

### 6. Teardown

```bash
# Ctrl-C the server, then:
docker compose down            # stop infra (keep data)
docker compose down -v         # stop + wipe volumes (clean slate)
```

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
├── main.ts                          # bootstrap (port via ConfigService)
├── app.module.ts                    # composition root: Config + Database + FileUpload + FileAnalysis
├── config/configuration.ts           # typed env config (server, S3, Redis, DB, thresholds)
├── common/                          # shared by both upload paths
│   ├── file.validator.ts            #   type checks (415) + the sync/async size threshold
│   ├── upload.constants.ts          #   MP3_FIELD_NAME
│   └── common.module.ts
├── database/database.module.ts       # the Postgres connection (isolated seam)
├── storage/                         # object storage
│   ├── storage.service.ts           #   S3 client → MinIO: putObject / getObjectStream / deleteObject
│   └── storage.module.ts
├── mp3/                             # framework-agnostic parsing core (no @nestjs outside the service)
│   ├── frame-counter.ts             #   StreamingFrameCounter (feed / finalize)
│   ├── frame-header-helper.ts       #   pure MPEG-1 Layer III header decode + tables
│   ├── id3-tag-helper.ts            #   pure ID3v2 tag-size reader
│   ├── vbr-header-helper.ts         #   Xing/Info/VBRI header-frame detection
│   ├── mp3-analyze.service.ts       #   createFrameCounter factory
│   ├── mp3.module.ts                #   shares the counter with both paths
│   ├── testing/mp3-fixtures.ts      #   synthetic MP3 builders (tests)
│   └── *.spec.ts                    #   counter + factory unit tests
├── file-upload/                     # the endpoint
│   ├── file-upload.controller.ts    #   POST /file-upload (branch on size) + GET /file-upload/:id
│   ├── file-upload.service.ts       #   sync path: busboy stream → counter
│   └── file-upload.module.ts
└── file-analysis/                   # async pipeline (DB-backed)
    ├── entities/file-upload.entity.ts   # FileUpload (file_uploads table) + status enum
    ├── file-analysis.service.ts         # acceptLargeUpload → S3 → enqueue · processUpload · status
    ├── mp3-analysis.processor.ts        # BullMQ @Processor (the worker)
    ├── file-analysis.constants.ts       # queue name + job payload type
    ├── file-analysis.dto.ts             # 202 + status response shapes
    └── file-analysis.module.ts          # entity + queue + worker wiring
test/
├── app.e2e-spec.ts                          # endpoint e2e — both branches + error paths
├── storage.integration-spec.ts              # S3 round-trip
├── file-analysis.integration-spec.ts        # processing · rollback · concurrency
├── mp3-analysis-queue.integration-spec.ts   # queue → worker → DB
├── scaling.integration-spec.ts              # N workers drain M jobs
├── memory.bench-spec.ts                     # O(1) memory benchmark (1 GB)
└── jest-{e2e,integration,bench}.json        # per-tier Jest configs
docker-compose.yml                   # MinIO (S3) + Redis + Postgres
docs/TESTING.md                      # full testing plan
.env.example                         # documented env vars
```

## Getting started

See [Quick start](#quick-start) above for the run commands. Notes:

- `cp .env.example .env` is optional — the built-in defaults match `docker-compose.yml`.
- TypeORM `synchronize` (dev-only, env-gated) auto-creates the `file_uploads` table on boot, so
  there's no manual migration step in dev.

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

## Backlog (given more time)

The current solution is complete for the assessment scope. With additional time, these would be the
next priorities:

- **Load testing at high traffic / throughput** — stress the sync and async paths under sustained
  concurrent uploads (e.g. k6 or Locust), measure queue depth, worker utilization, p95 latency,
  and failure rates; use the results to right-size worker count and connection limits.
- **Per-user throttling** — add rate limiting (e.g. `@nestjs/throttler` or a Redis-backed token
  bucket) on `POST /file-upload` and status polling so a single client cannot saturate the API or
  flood the job queue.
- **Formatting and linting enforcement** — ESLint + Prettier are configured (`npm run lint`,
  `npm run format`); next step is CI checks (`eslint` without `--fix`, `prettier --check`) and
  pre-commit hooks (e.g. husky + lint-staged) so style stays consistent on every commit/PR.
- **Production cloud deployment with auto-scaling and event-driven updates** — run API and worker
  as separate auto-scaled services (e.g. ECS/Kubernetes), use real S3 with presigned multipart
  uploads (client uploads directly, API never sees the bytes), and replace polling with
  event-driven job completion (S3 event notification → queue, webhook/SSE/WebSocket on `done`).

## Scripts

| Script | Description |
| ------ | ----------- |
| `npm run start:dev` / `start:prod` | Nest dev (watch) / compiled |
| `npm run build` · `npm run typecheck` | Compile · `tsc --noEmit` |
| `npm run format` · `npm run lint` | Prettier write · ESLint (`--fix`) |
| `npm run check` | CI gate: `format:check` + `lint:check` + `typecheck` |
| `npm test` · `test:e2e` · `test:integration` | Unit · endpoint e2e · infra integration |
| `npm run test:bench` · `test:cov` | Memory O(1) benchmark · coverage |
