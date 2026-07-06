import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Mp3Module } from '../mp3/mp3.module';
import { StorageModule } from '../storage/storage.module';
import { FileUpload } from './entities/file-upload.entity';
import { FileAnalysisService } from './file-analysis.service';

/**
 * Async large-file pipeline feature. Owns the {@link FileUpload} entity +
 * repository (the DB dependency), and streams stored objects through the shared
 * counter (Mp3Module) from object storage (StorageModule).
 *
 * The queue + @Processor worker are added in step 4b.
 */
@Module({
  imports: [TypeOrmModule.forFeature([FileUpload]), StorageModule, Mp3Module],
  providers: [FileAnalysisService],
  exports: [FileAnalysisService],
})
export class FileAnalysisModule {}
