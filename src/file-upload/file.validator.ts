import { Injectable, UnsupportedMediaTypeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { CONFIG_KEYS } from '../config/configuration';

/** Metadata of the multipart file part. */
export interface UploadPartInfo {
  filename?: string;
  mimeType?: string;
}

/**
 * Validates upload requests against the allowed file types and size limit.
 *
 * Validation happens in two places:
 *    - the content type is checked up front from the request's declared Content-Type`
 *      and the part's filename/MIME type (rejected with `415`).
 *    - the size is enforced mid-stream by the upload service via busboy's `fileSize` limit
 *      (rejected with `413`) because the size cannot be known in advance due to streaming.
 *  
 * This class owns the up-front type checks and 
 * exposes {@link maxBytes} for the service to apply the size limit.
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
      25 * 1024 * 1024; // 25MB default size limit
  }

  /**
   * Guard the request envelope before streaming begins and rejects with `415`
   * if the request is not a multipart/form-data request.
   */
  assertMultipart(request: Request): void {
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      throw new UnsupportedMediaTypeException(
        'Expected a multipart/form-data request',
      );
    }
  }

  /**
   * Validate the declared file-part metadata (mime type / extension) 
   * and rejects with `415` if the file is not an allowed type. 
   */
  assertAllowedType(info: UploadPartInfo): void {
    const mimeType = (info.mimeType ?? '').toLowerCase();
    const filename = (info.filename ?? '').toLowerCase();
    const mimeOk = this.allowedMimeTypes.includes(mimeType);
    const extOk = this.allowedExtensions.some((ext) => filename.endsWith(ext));
    if (!mimeOk && !extOk) {
      throw new UnsupportedMediaTypeException('Only MP3 files are accepted');
    }
  }
}
