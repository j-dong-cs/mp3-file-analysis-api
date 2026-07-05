# mp3-file-analysis-api

A **NestJS** API that accepts an MP3 upload and returns its audio frame count. The file is
**streamed and parsed while it uploads** (never fully buffered); the frame counter is
hand-written (no MP3-parsing library).

Current state: **skeleton** — controller, validator, and services are class structure with
**pseudocode** bodies (`throw "Not implemented"`), plus the standard `nest new` toolchain.

> Scope: MPEG Version 1, Audio Layer III (the standard `.mp3` format).

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
  → FileUploadController   # @Req() raw request (streaming, not FileInterceptor)
  → FileValidator          # type (415) + size limit (413, mid-stream)
  → FileUploadService      # countFramesWhileUpload — busboy stream
  → Mp3AnalyzeService      # createFrameCounter — per-upload state machine
  → { frameCount }
```

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
    ├── mp3-analyze.service.ts       # createFrameCounter             (pseudocode)
    └── mp3-analyze.service.spec.ts  # unit test scaffold
test/
├── app.e2e-spec.ts                  # e2e scaffold
└── jest-e2e.json
```

## Getting started

```bash
npm install
npm run format     # normalize hand-authored files to Prettier style
npm run start:dev  # → http://localhost:3000
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

Implement, in order: `Mp3AnalyzeService.createFrameCounter` → `FileUploadService` (busboy) →
`FileValidator` checks → `FileUploadController` (response + Nest exception mapping).
