# Testing Plan — mp3-file-analysis-api

## Running the tests

Start the infra first for the integration/e2e tiers: `docker compose up -d`.

| Command | Tier | Tests | Needs stack? |
| ------- | ---- | :---: | :----------: |
| `npm test` | Unit — parser core, helpers, factory | 26 | no |
| `npm run test:integration` | Storage, processing, rollback, queue→worker→DB, scaling | 9 | **yes** |
| `npm run test:e2e` | Endpoint — both branches + all error paths + concurrency | 9 | **yes** |
| `npm run test:bench` | Memory O(1) benchmark (streams 1 GB) | 1 | no |
| `npm run test:cov` | Unit coverage report | — | no |

**45 automated tests.** Unit + bench are hermetic (no Docker); integration + e2e need the stack.

## 1. Objectives

Assure that the system:

1. **Counts frames correctly** for MPEG-1 Layer III files (matches `mediainfo`).
2. **Parses robustly** — streaming, O(1) memory, resilient to chunk boundaries, tags, VBR, and junk.
3. **Honors the HTTP contract** — one `POST /file-upload` that branches on size (200 sync / 202 async), `GET /file-upload/:id`, and correct error codes (400/413/415/422/404).
4. **Runs the async pipeline reliably** — storage → queue → worker → DB, with retries and idempotency.
5. **Scales horizontally** — stateless instances + shared queue distribute work.
6. **Fails gracefully** — bad input, infra outages, aborted uploads, oversize files.

Out of scope (by product decision): non-MPEG-1-Layer-III formats.

## 2. Strategy — the test pyramid

| Tier | What | Speed / infra | Runner |
| ---- | ---- | ------------- | ------ |
| **Unit** | Parser core, pure helpers, validator, controller branch logic | fast, **hermetic** | `npm test` |
| **Integration** | Storage, repository/service, queue→worker→DB | needs Docker stack | `npm run test:integration` |
| **E2E** | The real endpoint, both branches | needs full app + stack | `npm run test:e2e` |
| **Non-functional** | Performance, memory, concurrency, resilience, scaling | needs stack / benchmarks | `test:bench` + integration/e2e |

Principles:
- **Deterministic fixtures.** Synthetic MP3 builders (`buildFrame`/`buildStream`/`buildVbrHeaderFrame`/`buildId3v2`) give *exact* expected counts — no reliance on binary sample files for unit tests.
- **Cross-check against a reference.** The real `sample.mp3` is validated against `mediainfo` (6089 frames) to catch decode drift the synthetic fixtures can't.
- **Drive the core directly.** The worker's logic is a plain `processUpload(id)`, tested without queue timing; the `@Processor` is a thin adapter.
- **Keep the fast tier hermetic.** Unit tests never touch Docker, so they run in every commit; infra tiers gate on the stack.

## 3. Coverage by area

Legend: ✅ implemented · ☐ to add.

### 3.1 MP3 parsing core (unit)

**`StreamingFrameCounter`** (`frame-counter.spec.ts`)
- ✅ CBR count (1 / 10 / 500 frames)
- ✅ Chunk-boundary invariance across many chunk sizes (1, 3, 4, 7, 50, 417, 1000, 100k)
- ✅ Padded frames; VBR sequence (per-frame bitrate + padding)
- ✅ ID3v2 skip — incl. footer, and split across chunks
- ✅ Leading-garbage resync; trailing ID3v1/junk ignored; empty chunks
- ✅ Xing/Info/VBRI header-frame excluded; only the *first* frame treated as a header
- ✅ 422 when no frames / nothing pushed
- ☐ **Property test**: random chunk-split of a fixture always yields the same count
- ☐ **Fuzz**: random byte streams never throw unexpectedly (return a count or 422)

**Pure helpers — currently exercised only *through* the counter; add direct unit tests:**
- ☐ `decodeFrameHeader`: `FF FB 90 00` → MPEG-1 L3, 128 kbps, 44100 Hz, len 417; every bitrate/sample-rate combo; `null` for bad sync / reserved version+layer / free(0)+bad(15) bitrate / reserved(3) sample rate / len ≤ 4; padding adds 1 byte; mono vs stereo `isMono`
- ☐ `readId3v2Size`: `"ID3"` + synchsafe size; footer flag adds 10; non-`ID3` → null; buffer < 10 → null
- ☐ `isVbrHeaderFrame` / `vbrProbeBytes`: Xing/Info at `4+sideInfo` (mono=21, stereo=36), VBRI at 36; non-VBR first frame not matched

**Real-file cross-check**
- ☐ `sample.mp3` → `frameCount === 6089` (fixture or `mediainfo` in an optional CI job)

### 3.2 Validation & controller (unit, hermetic — mock services)

- ☐ `FileValidator.assertMultipart`: multipart ok; other content-type → 415
- ☐ `FileValidator.assertAllowedType`: `audio/mpeg` / `audio/mp3` / `*.mp3` ok; else → 415
- ☐ `FileUploadController` branch (mocked `FileUploadService` + `FileAnalysisService`):
  - Content-Length ≤ threshold → calls sync service, status 200
  - Content-Length > threshold → calls async service, status 202
  - missing/NaN Content-Length → async branch
  - `GET /:id` found → 200 body; not found → 404

### 3.3 Async pipeline (integration — needs stack)

**`StorageService`** (`storage.integration-spec.ts`)
- ✅ Buffer round-trip (put → getStream → identical)
- ✅ 5 MB streamed body intact
- ☐ `getObjectStream` for a missing key rejects; `deleteObject` removes

**`FileAnalysisService.processUpload`** (`file-analysis.integration-spec.ts`)
- ✅ Happy path: S3 object → count → row `done` with `frameCount`
- ✅ Bad audio → row `failed` + re-throws
- ☐ Missing row → `NotFoundException`; missing object → `failed`
- ☐ **Idempotency**: processing the same upload twice yields the same count/state
- ✅ **Concurrency/isolation**: concurrent `processUpload` of distinct uploads → each row gets its own correct count (no shared state in the service)

**Queue → worker** (`mp3-analysis-queue.integration-spec.ts`)
- ✅ Enqueue → worker → DB `done`
- ☐ **Retry**: a job that fails transiently (e.g. object briefly absent) is retried and succeeds
- ☐ Failed job after N attempts lands in a failed state (not silently lost)

**`acceptLargeUpload`**
- ✅ Streams to S3, creates row, enqueues, returns `{ uploadId, statusUrl }` (202 shape) — covered end-to-end by the e2e large-file test (§3.4)
- ✅ **Malformed multipart → 400** (BadRequest, not 500)
- ✅ **Rollback on enqueue failure** — object + row both deleted, nothing left orphaned
- ☐ 415 wrong type; 400 no file part (integration-level; 415 is covered at the counter/e2e level)
- ☐ **413** over `MAX_ASYNC_UPLOAD_BYTES` (set a tiny cap) — and the partial object is cleaned up

### 3.4 E2E (needs full app + stack)

`app.e2e-spec.ts`
- ✅ small → 200 `{ frameCount }`; 415 non-multipart; 415 non-mp3; 400 no file; 422 small non-audio
- ✅ large → 202 → poll `GET /:id` → `done` with correct count; unknown id → 404
- ☐ **Real `sample.mp3`** through the sync path → `{ frameCount: 6089 }`
- ✅ **Concurrent uploads** (12 distinct counts, fired simultaneously) → each returns its own correct count
- ✅ **Malformed multipart body → 400** (not a 500)

### 3.5 Non-functional

- ✅ **Memory / O(1) proof** (`test/memory.bench-spec.ts`, `npm run test:bench`): streams 128 MB then 1 GB through the counter, sampling live RSS after forced GC. Result: retained-memory growth **3.6 MB (128 MB)** vs **0.0 MB (1 GB)** — flat regardless of input size, with 2.575M frames counted correctly. Runs in its own tier (`*.bench-spec.ts`) so it doesn't slow the unit suite.
- ◐ **Performance baseline** (measured, not yet asserted in CI): sync ~3–4 ms for the 1.46 MB sample; a real **1 GB** file parses in **~0.68 s** (~1.5 GB/s) at **92 MB** peak RSS. ☐ Turn into a tracked regression check.
- ✅ **Concurrency / isolation**: sync e2e (12 simultaneous distinct-count uploads) + async integration (concurrent `processUpload`) both prove per-request / per-upload state isolation — no cross-contamination. Guards the "one counter per upload" property.
- ✅ **Horizontal scaling** (`test/scaling.integration-spec.ts`): spins up N=4 BullMQ workers over the real `processUpload`, enqueues M=20 jobs, and asserts all complete, none lost (`total === M`), and every worker participated. Result: even **[5, 5, 5, 5]** distribution. Compile-only module so the built-in worker doesn't interfere; `queue.obliterate()` isolates it from other suites.
- ◐ **Resilience / failure injection** (partial):
  - ✅ enqueue failure → object + row rolled back (no orphaned `pending` rows)
  - ✅ (code) upload aborted mid-stream → 400 + best-effort cleanup, on both sync and async paths; ☐ add a deterministic abort test (needs socket-level teardown)
  - ☐ worker killed mid-job → BullMQ stalled-job redelivery re-runs it (relies on that mechanism)
  - ☐ Redis / Postgres / MinIO unavailable → clear 5xx, no data corruption
- ☐ **Input abuse**: filename `*.mp3` with non-audio bytes → 422 (parser is the real gate); dishonest `Content-Length`; unbounded chunked upload capped by the size limit.

## 4. Test data & fixtures

- **Synthetic** (`src/mp3/testing/mp3-fixtures.ts`): exact-count CBR/VBR streams, padded frames, ID3v2 (± footer), Xing/Info/VBRI header frames, mono vs stereo. Primary source for deterministic assertions.
- **Reference**: real `sample.mp3` cross-checked with `mediainfo --fullscan` (6089). Add a small committed real fixture, or an optional CI job that runs `mediainfo`.
  - **Caveat — `mediainfo`'s CBR "Frame count" is a bitrate-based *calculation*, not an actual count** (`fileSize × 8 ÷ bitrate ÷ frame-duration`). It matches this counter on properly-padded real files (padding averages the frame size to the nominal bitrate), but can differ on *synthetic unpadded* fixtures — where this counter's walk-and-count is the precise ground truth. So: assert synthetic counts against the known fixture value; use `mediainfo` only as a sanity check on real files.
- **Edge fixtures to formalize**: each bitrate/sample-rate combo, MPEG-1 mono, a large (>25 MB) synthetic file for the async path, a 1 GB stream for the memory test (generated, not committed).

## 5. Environments, tooling & CI

- **Four Jest configs**: unit (default, `rootDir: src`, hermetic), `jest-integration.json`, `jest-e2e.json` (both `--runInBand`; integration uses `--forceExit` for BullMQ sockets), and `jest-bench.json` (`test:bench`, run via `node --expose-gc`).
- **Local infra**: `docker compose up -d` (MinIO + Redis + Postgres).
- **CI pipeline** (recommended):
  1. `lint` → `typecheck`
  2. `test` (unit) — always, no infra
  3. bring up infra (compose service, or **Testcontainers** for hermetic per-run isolation)
  4. `test:integration` → `test:e2e`
  5. coverage gate + artifacts
- ☐ **Testcontainers** adoption so integration/e2e are self-contained in CI (no shared external stack).
- **Isolation between runs**: unique object keys + UUID rows already avoid collisions; add a teardown that truncates `file_uploads` and clears the test bucket/queue between integration runs.

## 6. Coverage targets & exit criteria

- **Coverage**: `src/mp3/**` (the risk-bearing core) ≥ **90%** lines/branches; overall ≥ **80%**. Enforce via `test:cov` thresholds.
- **Definition of done for a release**:
  - all tiers green (unit / integration / e2e / bench); coverage thresholds met
  - `sample.mp3` count equals `mediainfo`
  - O(1) memory benchmark within bounds
  - scaling test: N workers drain the queue, all jobs `done`

## 7. Prioritized backlog

Ranked by value-for-effort:

1. **Pure-function unit tests** — `decodeFrameHeader`, `readId3v2Size`, `vbr-header` (fast, hermetic, high defect-catching on the core).
2. **Controller branch unit tests** (mocked services) — lock the 200/202/404 routing without infra.
3. **`acceptLargeUpload` integration** — ◐ done (malformed→400, rollback, 202 via e2e); remaining: **413 cap + cleanup**, 415 wrong-type.
4. **Real `sample.mp3` e2e assertion** (6089) — end-to-end regression guard against decode drift.
5. **Idempotency + retry integration** — the reliability claims of the queue.
6. ~~Memory/O(1) benchmark~~ — ✅ done (`test:bench`).
7. ~~Concurrency/isolation test~~ — ✅ done (sync e2e + async integration).
8. **CI + Testcontainers** — make the infra tiers run anywhere.

## 8. Status snapshot

| Tier | Implemented | Notable gaps |
| ---- | ----------- | ------------ |
| Unit | 26 (counter 20, factory 6) | pure-helper direct tests, controller/validator units, property/fuzz |
| Integration | 9 (storage 2, file-analysis 5, queue 1, scaling 1) | retry, idempotency, 413 cap |
| E2E | 9 (both branches + all error paths + concurrency) | real-sample assertion |
| Non-functional | ✅ memory/O(1) benchmark; ✅ horizontal-scaling; ✅ concurrency/isolation; ◐ resilience | full failure injection, load |

**Total automated: 45.** The core parser is well-covered; the highest-value additions are the pure-helper unit tests, the async-accept integration cases, and the memory/scaling benchmarks.
