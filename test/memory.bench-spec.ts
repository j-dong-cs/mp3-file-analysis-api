import { StreamingFrameCounter } from '../src/mp3/frame-counter';
import { buildStream } from '../src/mp3/testing/mp3-fixtures';

/**
 * Memory benchmark — proves the streaming counter is O(1): its live memory
 * footprint does not grow with the amount of data processed.
 *
 * Run with GC exposed so we measure the *retained* set (not transient churn):
 *   npm run test:bench
 *
 * Method: feed one fixed chunk (a whole number of frames, reused — so the loop
 * allocates ~nothing) enough times to reach a target byte count, sampling RSS
 * after a forced GC. Also proves size-independence by comparing 128 MB vs 1 GB.
 */
const MB = 1024 * 1024;
const FRAMES_PER_CHUNK = 250; // ~104 KB per chunk (whole frames → carry stays empty)

const maybeGc = (globalThis as { gc?: () => void }).gc;

function rssMB(): number {
  return process.memoryUsage().rss / MB;
}

interface Result {
  frameCount: number;
  chunks: number;
  totalGB: number;
  baselineMB: number;
  peakMB: number;
  growthMB: number;
  elapsedMs: number;
}

/** Stream `targetBytes` of valid frames through a fresh counter, measuring live RSS. */
function runOverBytes(targetBytes: number): Result {
  const chunk = buildStream(FRAMES_PER_CHUNK); // allocated once, reused every feed
  const chunks = Math.ceil(targetBytes / chunk.length);
  const counter = new StreamingFrameCounter();

  maybeGc?.();
  const baselineMB = rssMB();
  let peakMB = baselineMB;
  const started = Date.now();

  for (let i = 0; i < chunks; i++) {
    counter.feed(chunk);
    if ((i & 0x3ff) === 0) {
      // Sample the RETAINED footprint (post-GC) every 1024 chunks.
      maybeGc?.();
      const r = rssMB();
      if (r > peakMB) peakMB = r;
    }
  }

  const frameCount = counter.finalize();
  const elapsedMs = Date.now() - started;

  return {
    frameCount,
    chunks,
    totalGB: (chunk.length * chunks) / (1024 * MB),
    baselineMB,
    peakMB,
    growthMB: peakMB - baselineMB,
    elapsedMs,
  };
}

describe('StreamingFrameCounter — memory (O(1))', () => {
  it('processes ~1 GB with bounded memory and a correct count', () => {
    if (!maybeGc) {
      throw new Error('run via `npm run test:bench` (needs node --expose-gc)');
    }

    const small = runOverBytes(128 * MB);
    const large = runOverBytes(1024 * MB);

    const fmt = (r: Result) =>
      `${r.totalGB.toFixed(2)} GB · ${r.frameCount.toLocaleString()} frames · ` +
      `baseline ${r.baselineMB.toFixed(1)} MB · peak ${r.peakMB.toFixed(1)} MB · ` +
      `growth ${r.growthMB.toFixed(1)} MB · ${r.elapsedMs} ms`;
    // eslint-disable-next-line no-console
    console.log(`  128 MB run → ${fmt(small)}`);
    // eslint-disable-next-line no-console
    console.log(`  1 GB run   → ${fmt(large)}`);

    // Correctness: every frame counted (no Xing frame in buildStream).
    expect(small.frameCount).toBe(FRAMES_PER_CHUNK * small.chunks);
    expect(large.frameCount).toBe(FRAMES_PER_CHUNK * large.chunks);

    // O(1): retained memory stays bounded despite ~1 GB processed...
    expect(large.growthMB).toBeLessThan(64);

    // ...and ~8x the data does NOT mean ~8x the memory (size-independent).
    expect(large.growthMB).toBeLessThan(small.growthMB + 48);
  }, 120000);
});
