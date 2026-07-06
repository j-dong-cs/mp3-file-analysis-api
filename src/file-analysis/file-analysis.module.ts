import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FileUpload } from './entities/file-upload.entity';

/**
 * Async large-file pipeline feature. Owns the {@link FileUpload} entity +
 * repository, so it is the one place that depends on the database. Kept separate
 * from the synchronous, DB-free FileUploadModule.
 *
 * Storage, queue, service, and worker are added in later steps.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FileUpload])],
})
export class FileAnalysisModule {}
