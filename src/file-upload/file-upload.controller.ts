import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { FileUploadService } from './file-upload.service';
import { FileValidator } from './file.validator';

/** Response shape (spec-exact): the success body is only `{ frameCount }`. */
export interface FrameCountResponse {
  frameCount: number;
}

/**
 * CONTROLLER — POST /file-upload  (multipart/form-data)
 *
 * Thin HTTP layer: validate the request envelope, delegate streaming+counting
 * to the service, return `{ frameCount }`. Uses `@Req()` (raw request) rather
 * than `@UploadedFile()` because we parse WHILE uploading (no full buffering).
 * Errors thrown below surface as Nest HttpExceptions → 400 / 413 / 415 / 422.
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
    // PSEUDOCODE:
    //   1. fileValidator.assertMultipart(request)                 // else 415
    //   2. frameCount = await fileUploadService.countFramesWhileUpload(request)
    //   3. return { frameCount }
    throw new Error('Not implemented: FileUploadController.fileUpload');
  }
}
