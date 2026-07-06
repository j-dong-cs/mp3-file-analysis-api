import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { FileUploadService } from './file-upload.service';
import { FileValidator } from './file.validator';

export interface FrameCountResponse {
  frameCount: number;
}

/**
 * HTTP controller for MP3 frame-count uploads.
 *
 * Exposes `POST /file-upload`, accepting a single MP3 as `multipart/form-data`
 * and responding with `{ frameCount }`. This is a thin transport layer: it
 * validates the request envelope and delegates the streaming parse and frame
 * counting to {@link FileUploadService}.
 *
 * The handler takes the raw request via `@Req()` (rather than `@UploadedFile()`)
 * so the file can be parsed while it uploads, without buffering the whole body.
 *
 * Failures raised by the validator or service propagate as Nest
 * `HttpException`s and map to the appropriate status codes:
 * `400` (missing file), `413` (too large), `415` (not multipart / not an MP3),
 * and `422` (no valid frames found).
 */
@Controller('file-upload')
export class FileUploadController {
  constructor(
    private readonly fileUploadService: FileUploadService,
    private readonly fileValidator: FileValidator,
  ) {}

  @Post()
  @HttpCode(200)
  async fileUpload(@Req() request: Request): Promise<FrameCountResponse> {
    this.fileValidator.assertMultipart(request);
    const frameCount =
      await this.fileUploadService.countFramesWhileUpload(request);
    return { frameCount };
  }
}
