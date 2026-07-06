import { Module } from '@nestjs/common';

import { StorageService } from './storage.service';

/**
 * Object storage (S3 / MinIO). Exports StorageService so the async pipeline
 * (accept → put to S3; worker → get stream from S3) can inject it.
 */
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
