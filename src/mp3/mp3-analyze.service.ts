import { Injectable } from '@nestjs/common';

import { FrameCounter, StreamingFrameCounter } from './frame-counter';

export type { FrameCounter };

/**
 * MP3 ANALYZE SERVICE
 *
 * Stateless factory: hands out a fresh {@link FrameCounter} per upload so
 * concurrent requests never share parsing state. The counting logic lives in
 * {@link StreamingFrameCounter} (see `frame-counter.ts`).
 */
@Injectable()
export class Mp3AnalyzeService {
  /** Build an isolated, single-use frame counter for one upload. */
  createFrameCounter(): FrameCounter {
    return new StreamingFrameCounter();
  }
}
