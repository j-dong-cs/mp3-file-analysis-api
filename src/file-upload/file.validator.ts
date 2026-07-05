import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { CONFIG_KEYS } from '../config/configuration';

/** Metadata of the multipart file part (as reported by busboy). */
export interface UploadPartInfo {
  filename?: string;
  mimeType?: string;
}

/**
 * FILE VALIDATOR — allowed file types & size.
 *
 * Streaming caveat (see design review):
 *   - TYPE  is validated from declared content-type / filename (→ 415).
 *   - SIZE  cannot be known up front, so `maxBytes` is enforced as a mid-stream
 *           limit by the upload service (busboy `fileSize`) → 413 when exceeded.
 */
@Injectable()
export class FileValidator {
  readonly allowedMimeTypes = ['audio/mpeg', 'audio/mp3'];
  readonly allowedExtensions = ['.mp3'];
  /** Max upload size in bytes, from config — enforced mid-stream by the service. */
  readonly maxBytes: number;

  constructor(private readonly configService: ConfigService) {
    this.maxBytes =
      this.configService.get<number>(CONFIG_KEYS.maxUploadBytes) ??
      25 * 1024 * 1024;
  }

  /** Guard the request envelope before streaming begins. */
  assertMultipart(request: Request): void {
    // PSEUDOCODE:
    //   if content-type does not start with "multipart/form-data"
    //     → throw UnsupportedMediaTypeException (415)
    throw new Error('Not implemented: FileValidator.assertMultipart');
  }

  /** Validate the declared file-part metadata (mime type / extension). */
  assertAllowedType(info: UploadPartInfo): void {
    // PSEUDOCODE:
    //   if info.mimeType not in allowedMimeTypes
    //      and info.filename extension not in allowedExtensions
    //     → throw UnsupportedMediaTypeException (415)
    throw new Error('Not implemented: FileValidator.assertAllowedType');
  }
}
