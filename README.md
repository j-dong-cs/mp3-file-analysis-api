# mp3-file-analysis-api

A **NestJS** API that accepts an MP3 upload and returns its audio frame count. The file is
**streamed and parsed while it uploads** (never fully buffered); the frame counter is
hand-written (no MP3-parsing library).

> Scope: MPEG Version 1, Audio Layer III (the standard `.mp3` format). The header decoder
> actually generalizes to MPEG-2/2.5 and Layers I–III, but MPEG-1 Layer III is what's required.

## Current state

- **MP3 parsing core — implemented & unit-tested.** The streaming frame counter and its pure
  helpers (frame-header decode, ID3v2 skip) are done, with 19 passing tests covering chunk-boundary
  invariance, VBR/padding, ID3v2 (incl. split across chunks), leading-garbage resync, trailing
  tags, and the empty/no-frame (422) cases.
- **HTTP layer — pseudocode.** `FileUploadController`, `FileValidator`, and `FileUploadService`
  are class structure with `throw "Not implemented"` bodies, to be filled in next.

## API contract (target)

`POST /file-upload` — one MP3 as `multipart/form-data`, field name `file`.

- **200** → `{ "frameCount": <number> }`
- Errors → **400** (no file) · **413** (too large) · **415** (not multipart / not an MP3) · **422** (no valid frames)

```bash
curl -F "file=@sample.mp3" http://localhost:3000/file-upload
```

## Request workflow

```
POST /file-upload
  → FileUploadController   # @Req() raw request (streaming, not FileInterceptor)   [pseudocode]
  → FileValidator          # type (415) + size limit (413, mid-stream)             [pseudocode]
  → FileUploadService      # countFramesWhileUpload — busboy stream                 [pseudocode]
  → Mp3AnalyzeService      # createFrameCounter — per-upload state machine          [done]
  → { frameCount }
```

## How frame counting works

The counter is a streaming state machine (`StreamingFrameCounter`) fed one chunk at a time, so
memory stays **O(1)** regardless of file size:

1. **Skip a leading ID3v2 tag** if present — the tag declares its own (synchsafe) size, so we jump it.
2. **Find the frame sync** (11 set bits: `0xFF`, `0xE0` mask) and decode the 4-byte header
   (version/layer/bitrate/sample-rate/padding) via fixed lookup tables → **frame length**.
3. **Hop to the next header** by the frame length, incrementing the count; only the 4-byte headers
   are inspected, payload is skipped (never buffered).
4. **Stop** at the first non-frame bytes after the audio (e.g. a trailing ID3v1 `TAG`).

Only unconsumed bytes at a chunk boundary (a partial header, or the remainder of a frame being
skipped) are carried between chunks — never the whole file.

## Structure

```
src/
├── main.ts                          # bootstrap (port via ConfigService)
├── app.module.ts                    # root module (global config)
├── config/configuration.ts          # typed env config
├── file-upload/
│   ├── file-upload.module.ts        # DI wiring
│   ├── file-upload.controller.ts    # POST /file-upload            (pseudocode)
│   ├── file.validator.ts            # allowed types & size          (pseudocode)
│   └── file-upload.service.ts       # countFramesWhileUpload         (pseudocode)
└── mp3/
    ├── mp3-analyze.service.ts       # createFrameCounter factory    (done)
    ├── frame-counter.ts             # StreamingFrameCounter state machine (done)
    ├── frame-header.ts              # pure MPEG frame-header decode + tables (done)
    ├── id3.ts                       # pure ID3v2 tag-size reader     (done)
    ├── frame-counter.spec.ts        # counter unit tests
    ├── mp3-analyze.service.spec.ts  # service (factory) unit tests
    └── testing/mp3-fixtures.ts      # synthetic MP3 builders for tests
test/
├── app.e2e-spec.ts                  # e2e scaffold (todos until HTTP layer lands)
└── jest-e2e.json
```

The `mp3/` core is **framework-agnostic** (no `@nestjs` imports outside the thin service), so the
same counter can later be reused by, e.g., an async worker reading from object storage.

## Getting started

```bash
npm install
cp .env.example .env   # optional: PORT, MAX_UPLOAD_BYTES
npm run start:dev      # → http://localhost:3000
```

## Scripts

| Script | Description |
| ------ | ----------- |
| `npm run start:dev` | Nest dev server (watch) |
| `npm run build` / `npm run start:prod` | Build / run compiled |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (`--fix`) |
| `npm run format` | Prettier write |
| `npm test` / `test:watch` / `test:cov` | Jest unit tests |
| `npm run test:e2e` | Jest e2e |

## Next step

Implement the HTTP layer, in order: `FileValidator` checks (415 / mid-stream 413) →
`FileUploadService` (busboy streaming into `createFrameCounter`) → `FileUploadController`
(response + Nest exception mapping), then enable the e2e `it.todo`s.
