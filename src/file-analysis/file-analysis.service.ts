import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import busboy from 'busboy';
import { Queue } from 'bullmq';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import { FileValidator } from '../common/file.validator';
import { MP3_FIELD_NAME } from '../common/upload.constants';
import { CONFIG_KEYS } from '../config/configuration';
import { Mp3AnalyzeService } from '../mp3/mp3-analyze.service';
import { StorageService } from '../storage/storage.service';
import {
  AnalyzeUploadJob,
  MP3_ANALYSIS_QUEUE,
} from './file-analysis.constants';
import { BigFileUploadResponse } from './file-analysis.dto';
import { FileUpload, FileUploadStatus } from './entities/file-upload.entity';

export interface CreateUploadParams {
  storageKey: string;
  originalFilename?: string | null;
  contentType?: string | null;
}

/**
 * Owns the FileUpload lifecycle: create the record, and process it (stream the
 * object from storage through the shared frame counter, persist the result).
 * The queue/worker calls {@link processUpload} to run the job;
 */
@Injectable()
export class FileAnalysisService {
  constructor(
    @InjectRepository(FileUpload)
    private readonly fileUploadRepo: Repository<FileUpload>,
    @InjectQueue(MP3_ANALYSIS_QUEUE)
    private readonly analysisQueue: Queue<AnalyzeUploadJob>,
    private readonly storage: StorageService,
    private readonly mp3: Mp3AnalyzeService,
    private readonly fileValidator: FileValidator,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Accept a large upload: stream the file part straight to object storage
   * (never buffered), record it, and enqueue a background job. Returns the
   * upload id + status URL for the client to poll (the controller sends 202).
   */
  acceptLargeUpload(request: Request): Promise<BigFileUploadResponse> {
    return new Promise<BigFileUploadResponse>((resolve, reject) => {
      const maxBytes = this.configService.getOrThrow<number>(
        CONFIG_KEYS.maxAsyncUploadBytes,
      );
      let parser: ReturnType<typeof busboy>;
      try {
        parser = busboy({
          headers: request.headers,
          limits: { files: 1, fileSize: maxBytes },
        });
      } catch {
        reject(new BadRequestException('Malformed multipart request'));
        return;
      }

      let settled = false;
      let sawFile = false;
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        request.unpipe(parser);
        reject(err);
      };
      const succeed = (result: BigFileUploadResponse): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      parser.on('file', (fieldName, fileStream, info) => {
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
        const key = `uploads/${randomUUID()}.mp3`;
        let tooLarge = false;
        fileStream.on('limit', () => {
          tooLarge = true;
          fail(
            new PayloadTooLargeException(
              'File exceeds the maximum allowed size',
            ),
          );
        });
        fileStream.on('error', fail);

        void (async () => {
          let createdId: string | null = null;
          try {
            await this.storage.putObject(key, fileStream, info.mimeType);
            if (tooLarge || settled) {
              await this.storage.deleteObject(key).catch(() => undefined);
              return;
            }
            const upload = await this.create({
              storageKey: key,
              originalFilename: info.filename ?? null,
              contentType: info.mimeType ?? null,
            });
            createdId = upload.id;
            await this.enqueue(upload.id);
            succeed({
              uploadId: upload.id,
              status: upload.status,
              statusUrl: `/file-upload/${upload.id}`,
            });
          } catch (err) {
            // Roll back so nothing is left orphaned: drop the object, and the
            // row too if we created it (e.g. enqueue failed → no worker would
            // ever pick it up, so it must not linger as `pending`).
            await this.storage.deleteObject(key).catch(() => undefined);
            if (createdId) {
              await this.fileUploadRepo
                .delete(createdId)
                .catch(() => undefined);
            }
            fail(err);
          }
        })();
      });

      parser.on('close', () => {
        if (!settled && !sawFile) {
          fail(
            new BadRequestException(
              `No file uploaded under field "${MP3_FIELD_NAME}"`,
            ),
          );
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

  /** Create a pending upload record. */
  create(params: CreateUploadParams): Promise<FileUpload> {
    const upload = this.fileUploadRepo.create({
      storageKey: params.storageKey,
      originalFilename: params.originalFilename ?? null,
      contentType: params.contentType ?? null,
      status: FileUploadStatus.Pending,
    });
    return this.fileUploadRepo.save(upload);
  }

  findById(id: string): Promise<FileUpload | null> {
    return this.fileUploadRepo.findOneBy({ id });
  }

  /**
   * Enqueue a background job to analyze an already-stored upload.
   * Retries with backoff (the parse is deterministic, so retries are safe).
   */
  async enqueue(uploadId: string): Promise<void> {
    await this.analysisQueue.add(
      'analyze',
      { uploadId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  /**
   * Stream the stored object through the frame counter and persist the result.
   * Marks the row processing → done (with frameCount) or failed (with the
   * error). Re-throws so an at-least-once queue can retry.
   */
  async processUpload(uploadId: string): Promise<void> {
    const upload = await this.fileUploadRepo.findOneBy({ id: uploadId });
    if (!upload) {
      throw new NotFoundException(`Upload ${uploadId} not found`);
    }

    await this.fileUploadRepo.update(uploadId, {
      status: FileUploadStatus.Processing,
    });

    try {
      const counter = this.mp3.createFrameCounter();
      const stream = await this.storage.getObjectStream(upload.storageKey);
      let bytesProcessed = 0;
      for await (const chunk of stream) {
        const buf = chunk as Buffer;
        bytesProcessed += buf.length;
        counter.feed(buf);
      }
      const frameCount = counter.finalize();

      await this.fileUploadRepo.update(uploadId, {
        status: FileUploadStatus.Done,
        frameCount,
        sizeBytes: bytesProcessed,
        errorMessage: null,
        completedAt: new Date(),
      });
    } catch (err) {
      await this.fileUploadRepo.update(uploadId, {
        status: FileUploadStatus.Failed,
        errorMessage: err instanceof Error ? err.message : 'Unknown error',
        completedAt: new Date(),
      });
      throw err;
    }
  }
}
