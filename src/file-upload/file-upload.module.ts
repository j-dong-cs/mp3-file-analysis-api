import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module';
import { FileAnalysisModule } from '../file-analysis/file-analysis.module';
import { Mp3Module } from '../mp3/mp3.module';
import { FileUploadController } from './file-upload.controller';
import { FileUploadService } from './file-upload.service';

/**
 * The `POST /file-upload` endpoint. Branches on Content-Length:
 *   - small (≤ threshold) → FileUploadService streams + counts → 200 { frameCount }
 *   - large (> threshold)  → FileAnalysisService stores + enqueues → 202 { uploadId }
 * Also serves GET /file-upload/:id for async status.
 */
@Module({
  imports: [CommonModule, Mp3Module, FileAnalysisModule],
  controllers: [FileUploadController],
  providers: [FileUploadService],
})
export class FileUploadModule {}
