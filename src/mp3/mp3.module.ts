import { Module } from '@nestjs/common';

import { Mp3AnalyzeService } from './mp3-analyze.service';

/**
 * Shared MP3 analysis. Exports the framework-agnostic frame-counter factory so
 * multiple features reuse the SAME counter without duplicating providers:
 *   - the synchronous streaming endpoint (FileUploadModule), and
 *   - the async large-file worker (added in a later step).
 */
@Module({
  providers: [Mp3AnalyzeService],
  exports: [Mp3AnalyzeService],
})
export class Mp3Module {}
