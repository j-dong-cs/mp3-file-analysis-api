import { Injectable } from '@nestjs/common';

import { FrameCounter, StreamingFrameCounter } from './frame-counter';

// Re-exported for consumers that import the counter type from the service.
export type { FrameCounter };

/**
 * SERVICE — constructs the MP3 frame counter.
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
