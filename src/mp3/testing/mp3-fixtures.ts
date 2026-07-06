import type { FrameCounter } from '../frame-counter';

/**
 * Deterministic synthetic MP3 builders for tests. Because we control the
 * headers, the expected frame count is exact — no binary sample files needed.
 *
 * All frames are MPEG-1 Layer III (the in-scope format).
 */

/** MPEG-1 Layer III: kbps → 4-bit bitrate index. */
const BITRATE_INDEX: Record<number, number> = {
  32: 1, 40: 2, 48: 3, 56: 4, 64: 5, 80: 6, 96: 7, 112: 8,
  128: 9, 160: 10, 192: 11, 224: 12, 256: 13, 320: 14,
};

/** MPEG-1: sample rate Hz → 2-bit index. */
const SAMPLE_RATE_INDEX: Record<number, number> = { 44100: 0, 48000: 1, 32000: 2 };

export interface FrameSpec {
  /** CBR bitrate in kbps (default 128). */
  bitrateKbps?: number;
  /** Sample rate in Hz (default 44100). */
  sampleRateHz?: number;
  /** Padding bit — adds 1 byte to the frame (default 0). */
  padding?: 0 | 1;
}

/** Frame length in bytes for a MPEG-1 Layer III frame. */
export function frameLength(spec: FrameSpec = {}): number {
  const bitrateKbps = spec.bitrateKbps ?? 128;
  const sampleRateHz = spec.sampleRateHz ?? 44100;
  const padding = spec.padding ?? 0;
  return Math.floor((144 * bitrateKbps * 1000) / sampleRateHz) + padding;
}

/** Build a single valid MPEG-1 Layer III frame (header + zero-filled payload). */
export function buildFrame(spec: FrameSpec = {}): Buffer {
  const bitrateKbps = spec.bitrateKbps ?? 128;
  const sampleRateHz = spec.sampleRateHz ?? 44100;
  const padding = spec.padding ?? 0;

  const bitrateIdx = BITRATE_INDEX[bitrateKbps];
  const srIdx = SAMPLE_RATE_INDEX[sampleRateHz];
  if (bitrateIdx === undefined || srIdx === undefined) {
    throw new Error(`Unsupported fixture params: ${bitrateKbps}kbps @ ${sampleRateHz}Hz`);
  }

  // byte1 = 1111 1011: sync(111) + version 11 (MPEG1) + layer 01 (III) + no CRC.
  // byte2 = EEEE FF G H: bitrate idx, sample-rate idx, padding, private.
  const b2 = (bitrateIdx << 4) | (srIdx << 2) | (padding << 1);
  const header = Buffer.from([0xff, 0xfb, b2, 0x00]);
  return Buffer.concat([header, Buffer.alloc(frameLength(spec) - 4)]);
}

/** Concatenate `count` identical frames. */
export function buildStream(count: number, spec: FrameSpec = {}): Buffer {
  return Buffer.concat(Array.from({ length: count }, () => buildFrame(spec)));
}

/** Concatenate a heterogeneous (e.g. VBR) sequence of frames. */
export function buildFrames(specs: FrameSpec[]): Buffer {
  return Buffer.concat(specs.map((s) => buildFrame(s)));
}

/**
 * Build a VBR/encoder info header frame (the metadata frame encoders place at
 * the start of the audio). It is a structurally-valid frame carrying a
 * `Xing` / `Info` / `VBRI` marker instead of audio.
 *
 * The default stereo frame has a 32-byte side-info block, so `Xing`/`Info` sit
 * at offset `4 + 32 = 36`; `VBRI` is fixed at offset 36 too — so all markers
 * land at 36 here. Uses a bitrate large enough to hold the marker.
 */
export function buildVbrHeaderFrame(
  marker: 'Xing' | 'Info' | 'VBRI' = 'Xing',
  spec: FrameSpec = {},
): Buffer {
  const frame = Buffer.from(buildFrame(spec)); // writable copy
  frame.write(marker, 36, 'ascii');
  return frame;
}

/**
 * Build a synthetic ID3v2 tag. `bodyBytes` is the declared (synchsafe) size;
 * a footer adds a trailing 10 bytes. Total skip = 10 + bodyBytes (+10 footer).
 */
export function buildId3v2(bodyBytes: number, opts: { footer?: boolean } = {}): Buffer {
  const footer = opts.footer ?? false;
  const flags = footer ? 0x10 : 0x00;
  const size = Buffer.from([
    (bodyBytes >> 21) & 0x7f,
    (bodyBytes >> 14) & 0x7f,
    (bodyBytes >> 7) & 0x7f,
    bodyBytes & 0x7f,
  ]);
  return Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, flags]), // "ID3" v2.4
    size,
    Buffer.alloc(bodyBytes),
    footer ? Buffer.alloc(10) : Buffer.alloc(0),
  ]);
}

/** Feed a buffer into a counter in fixed-size chunks (to exercise boundaries). */
export function pushInChunks(counter: FrameCounter, buf: Buffer, chunkSize: number): void {
  for (let i = 0; i < buf.length; i += chunkSize) {
    counter.feed(buf.subarray(i, i + chunkSize));
  }
}
