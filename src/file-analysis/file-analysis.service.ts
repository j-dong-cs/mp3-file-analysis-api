import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';

import { Mp3AnalyzeService } from '../mp3/mp3-analyze.service';
import { StorageService } from '../storage/storage.service';
import {
  AnalyzeUploadJob,
  MP3_ANALYSIS_QUEUE,
} from './file-analysis.constants';
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
  ) {}

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
