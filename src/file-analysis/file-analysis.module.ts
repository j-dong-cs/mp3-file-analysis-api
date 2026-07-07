import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CONFIG_KEYS, RedisConfig } from '../config/configuration';
import { Mp3Module } from '../mp3/mp3.module';
import { StorageModule } from '../storage/storage.module';
import { FileUpload } from './entities/file-upload.entity';
import { MP3_ANALYSIS_QUEUE } from './file-analysis.constants';
import { FileAnalysisService } from './file-analysis.service';
import { Mp3AnalysisProcessor } from './mp3-analysis.processor';

/**
 * Async large-file pipeline. Owns the FileUpload entity/repository, the BullMQ
 * queue (Redis), and the worker that streams stored objects through the shared
 * counter (Mp3Module) and persists results.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([FileUpload]),
    StorageModule,
    Mp3Module,
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redis = configService.getOrThrow<RedisConfig>(CONFIG_KEYS.redis);
        return { connection: { host: redis.host, port: redis.port } };
      },
    }),
    BullModule.registerQueue({ name: MP3_ANALYSIS_QUEUE }),
  ],
  providers: [FileAnalysisService, Mp3AnalysisProcessor],
  exports: [FileAnalysisService],
})
export class FileAnalysisModule {}
