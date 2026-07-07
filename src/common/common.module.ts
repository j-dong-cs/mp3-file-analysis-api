import { Module } from '@nestjs/common';

import { FileValidator } from './file.validator';

/** Shared building blocks used by both upload paths. */
@Module({
  providers: [FileValidator],
  exports: [FileValidator],
})
export class CommonModule {}
