import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { Mp3AnalyzeService } from '../mp3/mp3-analyze.service';
import { FileValidator } from './file.validator';

/** Multipart field name the client must use for the MP3 file. */
export const MP3_FIELD_NAME = 'file';

/**
 * SERVICE — countFramesWhileUpload
 *
 * Streams the multipart request and counts frames as the bytes arrive, so the
 * file is never fully buffered (O(1) memory). Uses `FileValidator` for the part
 * checks + size limit, and `Mp3AnalyzeService` for the per-upload frame counter.
 */
@Injectable()
export class FileUploadService {
  constructor(
    private readonly mp3AnalyzeService: Mp3AnalyzeService,
    private readonly fileValidator: FileValidator,
  ) {}

  countFramesWhileUpload(request: Request): Promise<number> {
    // PSEUDOCODE:
    //   parser  = busboy({ headers: request.headers,
    //                      limits: { files: 1, fileSize: fileValidator.maxBytes } })
    //   counter = mp3AnalyzeService.createFrameCounter()   // fresh per-request state
    //
    //   on parser 'file' (field, stream, info):
    //     if field !== MP3_FIELD_NAME        → stream.resume() (drain & ignore)
    //     fileValidator.assertAllowedType(info)             // else 415
    //     on stream 'data'  (chunk)          → counter.push(chunk)
    //     on stream 'limit'                  → reject PayloadTooLarge (413)
    //     on stream 'error'                  → reject
    //
    //   on parser 'close':
    //     if no file part was seen           → reject BadRequest (400)
    //     else resolve counter.end()         // frame count (throws 422 if none)
    //
    //   request.pipe(parser)                 // settle the promise exactly once
    throw new Error(
      'Not implemented: FileUploadService.countFramesWhileUpload',
    );
  }
}
