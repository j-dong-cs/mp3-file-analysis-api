import {
  BadRequestException,
  Injectable,
  PayloadTooLargeException,
} from '@nestjs/common';
import busboy from 'busboy';
import type { Request } from 'express';

import { FileValidator } from '../common/file.validator';
import { MP3_FIELD_NAME } from '../common/upload.constants';
import { Mp3AnalyzeService } from '../mp3/mp3-analyze.service';

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
    return new Promise<number>((resolve, reject) => {
      let parser: ReturnType<typeof busboy>;
      try {
        // busboy throws synchronously on a bad content-type (e.g. no boundary).
        parser = busboy({
          headers: request.headers,
          limits: { files: 1, fileSize: this.fileValidator.maxBytes },
        });
      } catch {
        reject(new BadRequestException('Malformed multipart request'));
        return;
      }
      const counter = this.mp3AnalyzeService.createFrameCounter();

      let settled = false;
      let sawFile = false;

      // The promise must settle exactly once; busboy emits many events.
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        request.unpipe(parser);
        reject(err);
      };
      const succeed = (count: number): void => {
        if (settled) return;
        settled = true;
        resolve(count);
      };

      parser.on('file', (fieldName, fileStream, info) => {
        // Every file stream must be consumed or busboy stalls (backpressure).
        if (fieldName !== MP3_FIELD_NAME) {
          fileStream.resume();
          return;
        }

        try {
          this.fileValidator.assertAllowedType(info);
        } catch (err) {
          fileStream.resume();
          fail(err);
          return;
        }

        sawFile = true;
        fileStream.on('data', (chunk: Buffer) => {
          if (settled) return;
          try {
            counter.feed(chunk);
          } catch (err) {
            fail(err);
          }
        });
        fileStream.on('limit', () =>
          fail(
            new PayloadTooLargeException(
              'File exceeds the maximum allowed size',
            ),
          ),
        );
        fileStream.on('error', fail);
      });

      parser.on('close', () => {
        if (settled) return;
        if (!sawFile) {
          fail(
            new BadRequestException(
              `No file uploaded under field "${MP3_FIELD_NAME}"`,
            ),
          );
          return;
        }
        try {
          succeed(counter.finalize());
        } catch (err) {
          fail(err); // finalize() throws 422 when no frames were found
        }
      });
      // A parser-level error means the multipart body is malformed → 400.
      parser.on('error', () =>
        fail(new BadRequestException('Malformed multipart request')),
      );

      request.on('aborted', () =>
        fail(new BadRequestException('Upload aborted before completion')),
      );

      request.pipe(parser);
    });
  }
}
