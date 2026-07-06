import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { FileAnalysisModule } from './file-analysis/file-analysis.module';
import { FileUploadModule } from './file-upload/file-upload.module';

/**
 * Production composition root.
 *   ConfigModule       — global env config
 *   DatabaseModule     — the Postgres connection (isolated seam)
 *   FileUploadModule   — synchronous streaming endpoint (DB-free)
 *   FileAnalysisModule — async large-file pipeline (owns the FileUpload entity)
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    DatabaseModule,
    FileUploadModule,
    FileAnalysisModule,
  ],
})
export class AppModule {}
