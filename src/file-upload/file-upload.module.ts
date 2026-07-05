import { Module } from '@nestjs/common';

import { Mp3AnalyzeService } from '../mp3/mp3-analyze.service';
import { FileUploadController } from './file-upload.controller';
import { FileUploadService } from './file-upload.service';
import { FileValidator } from './file.validator';

/**
 * Feature module for the upload endpoint.
 *
 * Wiring (DI graph):
 *   FileUploadController ──▶ FileValidator          (allowed types & size)
 *                        └─▶ FileUploadService ──▶ Mp3AnalyzeService (frame counter)
 */
@Module({
  controllers: [FileUploadController],
  providers: [FileValidator, FileUploadService, Mp3AnalyzeService],
})
export class FileUploadModule {}
