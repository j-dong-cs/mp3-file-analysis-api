import { Module } from '@nestjs/common';

import { Mp3Module } from '../mp3/mp3.module';
import { FileUploadController } from './file-upload.controller';
import { FileUploadService } from './file-upload.service';
import { FileValidator } from './file.validator';

/**
 * Synchronous streaming endpoint (`POST /file-upload`). DB-free by design — it
 * streams and counts in one request, so it boots with no infra. The DB-backed
 * async pipeline lives in FileAnalysisModule.
 *
 * Wiring (DI graph):
 *   FileUploadController ──▶ FileValidator          (allowed types & size)
 *                        └─▶ FileUploadService ──▶ Mp3AnalyzeService (frame counter)
 */
@Module({
  imports: [Mp3Module],
  controllers: [FileUploadController],
  providers: [FileValidator, FileUploadService],
})
export class FileUploadModule {}
