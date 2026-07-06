import { UnprocessableEntityException } from '@nestjs/common';

import { StreamingFrameCounter } from './frame-counter';
import {
  buildFrames,
  buildId3v2,
  buildStream,
  buildVbrHeaderFrame,
  pushInChunks,
} from './testing/mp3-fixtures';

function countWhole(buf: Buffer): number {
  const counter = new StreamingFrameCounter();
  counter.feed(buf);
  return counter.finalize();
}

function countChunked(buf: Buffer, chunkSize: number): number {
  const counter = new StreamingFrameCounter();
  pushInChunks(counter, buf, chunkSize);
  return counter.finalize();
}

describe('StreamingFrameCounter', () => {
  it('counts CBR frames delivered in one push', () => {
    expect(countWhole(buildStream(10))).toBe(10);
    expect(countWhole(buildStream(1))).toBe(1);
    expect(countWhole(buildStream(500))).toBe(500);
  });

  it('is invariant to chunk boundaries', () => {
    const buf = buildStream(37);
    // 1-byte chunks split every single header; larger chunks straddle frames.
    for (const chunkSize of [1, 3, 4, 7, 50, 417, 1000, 100_000]) {
      expect(countChunked(buf, chunkSize)).toBe(37);
    }
  });

  it('counts padded frames', () => {
    expect(countChunked(buildStream(12, { padding: 1 }), 40)).toBe(12);
  });

  it('counts a VBR sequence (per-frame bitrate + padding)', () => {
    const buf = buildFrames([
      { bitrateKbps: 128, padding: 0 },
      { bitrateKbps: 192, padding: 1 },
      { bitrateKbps: 64, padding: 0 },
      { bitrateKbps: 320, padding: 1 },
      { bitrateKbps: 96, padding: 0 },
    ]);
    expect(countChunked(buf, 13)).toBe(5);
  });

  it('skips a leading ID3v2 tag', () => {
    const buf = Buffer.concat([buildId3v2(1234), buildStream(8)]);
    expect(countChunked(buf, 64)).toBe(8);
  });

  it('skips a leading ID3v2 tag that has a footer', () => {
    const buf = Buffer.concat([buildId3v2(500, { footer: true }), buildStream(6)]);
    expect(countChunked(buf, 50)).toBe(6);
  });

  it('skips a leading ID3v2 tag when its header is split across chunks', () => {
    // Chunk sizes < the 10-byte ID3v2 header force the counter to accumulate
    // the magic (3 bytes) and header (10 bytes) across multiple pushes.
    const buf = Buffer.concat([buildId3v2(1234), buildStream(8)]);
    for (const chunkSize of [1, 2, 3, 7, 10]) {
      expect(countChunked(buf, chunkSize)).toBe(8);
    }
  });

  it('survives worst-case fragmentation: ID3v2 + frames + trailing tag in 1-byte chunks', () => {
    const buf = Buffer.concat([
      buildId3v2(300),
      buildStream(9),
      Buffer.from('TAGtrailing id3v1 metadata'),
    ]);
    expect(countChunked(buf, 1)).toBe(9);
  });

  it('resyncs past leading garbage before the first frame', () => {
    const buf = Buffer.concat([Buffer.alloc(53), buildStream(4)]);
    expect(countChunked(buf, 16)).toBe(4);
  });

  it('ignores trailing bytes after the audio (e.g. ID3v1 TAG)', () => {
    const buf = Buffer.concat([buildStream(5), Buffer.from('TAGsome trailing metadata')]);
    expect(countChunked(buf, 33)).toBe(5);
  });

  it('ignores empty chunks', () => {
    const counter = new StreamingFrameCounter();
    counter.feed(Buffer.alloc(0));
    counter.feed(buildStream(3));
    counter.feed(Buffer.alloc(0));
    expect(counter.finalize()).toBe(3);
  });

  it('throws 422 when no frames are found', () => {
    const counter = new StreamingFrameCounter();
    counter.feed(Buffer.alloc(2000));
    expect(() => counter.finalize()).toThrow(UnprocessableEntityException);
  });

  it('throws 422 when nothing was ever pushed', () => {
    expect(() => new StreamingFrameCounter().finalize()).toThrow(UnprocessableEntityException);
  });
});

describe('StreamingFrameCounter — VBR header frame (Xing/Info/VBRI)', () => {
  it.each(['Xing', 'Info', 'VBRI'] as const)(
    'does not count a leading %s header frame',
    (marker) => {
      const buf = Buffer.concat([buildVbrHeaderFrame(marker), buildStream(10)]);
      expect(countWhole(buf)).toBe(10); // 10 audio frames, header frame excluded
    },
  );

  it('excludes the Xing frame after a leading ID3v2 tag', () => {
    const buf = Buffer.concat([
      buildId3v2(100),
      buildVbrHeaderFrame('Xing'),
      buildStream(9),
    ]);
    expect(countWhole(buf)).toBe(9);
  });

  it('excludes the Xing frame regardless of chunk boundaries', () => {
    const buf = Buffer.concat([buildVbrHeaderFrame('Xing'), buildStream(15)]);
    // Small chunks force the counter to accumulate enough bytes to classify the
    // first frame across multiple feeds before deciding to skip it.
    for (const chunkSize of [1, 7, 36, 40, 417, 5000]) {
      expect(countChunked(buf, chunkSize)).toBe(15);
    }
  });

  it('still counts a normal first frame (no VBR marker)', () => {
    expect(countWhole(buildStream(1))).toBe(1);
  });

  it('only the first frame is treated as a possible header (Xing-like bytes later are audio)', () => {
    // A later frame that happens to contain "Xing" bytes must still be counted.
    const buf = Buffer.concat([
      buildStream(1),
      buildVbrHeaderFrame('Xing'), // 2nd frame — should NOT be skipped
      buildStream(3),
    ]);
    expect(countWhole(buf)).toBe(5);
  });
});
