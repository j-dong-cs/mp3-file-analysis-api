/**
 * Pure MP3 frame-header decoding (ISO/IEC 11172-3 / 13818-3) helper.
 *
 * The header stores small indices; the real values come from the fixed lookup tables below.
 * The current implementation only supports MPEG1 Layer III.
 * 
 * @see https://en.wikipedia.org/wiki/MPEG-1_Audio_Layer_III
 * @see https://en.wikipedia.org/wiki/ISO/IEC_11172-3
 * @see https://en.wikipedia.org/wiki/ISO/IEC_13818-3
 */

export type MpegVersion = 'MPEG1';
export type MpegLayer = 'Layer III';

export interface DecodedFrameHeader {
  version: MpegVersion;
  layer: MpegLayer;
  bitrateKbps: number;
  sampleRateHz: number;
  samplesPerFrame: number;
  /** Total frame length in bytes (header + payload) — the hop to the next header. */
  frameLengthBytes: number;
}

/** Version bits (byte 1, bits 4-3); `01` is reserved. */
const VERSION_BY_BITS: Record<number, MpegVersion | undefined> = {
  0b01: undefined,
  0b11: 'MPEG1',
};

/** Layer bits (byte 1, bits 2-1); `00` is reserved. */
const LAYER_BY_BITS: Record<number, MpegLayer | undefined> = {
  0b00: undefined,
  0b01: 'Layer III',
};

/** Bitrate in kbps by the 4-bit index. 0 = free, -1 = bad (both rejected). */
const BITRATE_KBPS: Record<MpegVersion, Record<MpegLayer, readonly number[]>> = {
  MPEG1: {
    'Layer III': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  },
};

/** Sample rate in Hz by the 2-bit index. -1 = reserved (rejected). */
const SAMPLE_RATE_HZ: Record<MpegVersion, readonly number[]> = {
  MPEG1: [44100, 48000, 32000, -1],
};

/** PCM samples encoded per frame, by version + layer. */
const SAMPLES_PER_FRAME: Record<MpegVersion, Record<MpegLayer, number>> = {
  MPEG1: { 'Layer III': 1152 },
};

/**
 * Decode the 4-byte frame header at `buf[offset]`. Returns the decoded header,
 * or `null` if these bytes are not a valid frame (bad sync, reserved
 * version/layer, free/bad bitrate, reserved sample rate, or zero length).
 *
 * `frameLengthBytes` is the WHOLE frame (header + payload) — advance the cursor
 * by exactly this much to land on the next header. Do not also consume the
 * 4 header bytes separately.
 */
export function decodeFrameHeader(buf: Buffer, offset: number): DecodedFrameHeader | null {
  if (offset + 4 > buf.length) return null;

  const b0 = buf[offset];
  const b1 = buf[offset + 1];
  const b2 = buf[offset + 2];

  // Sync word: 11 set bits.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const version = VERSION_BY_BITS[(b1 >> 3) & 0x03];
  const layer = LAYER_BY_BITS[(b1 >> 1) & 0x03];
  if (!version || !layer) return null; // reserved

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;

  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null; // free / bad
  if (sampleRateIndex === 0x03) return null; // reserved

  const bitrateKbps = BITRATE_KBPS[version][layer][bitrateIndex];
  const sampleRateHz = SAMPLE_RATE_HZ[version][sampleRateIndex];
  const samplesPerFrame = SAMPLES_PER_FRAME[version][layer];
  const bitrateBps = bitrateKbps * 1000;

  // MPEG-1 Layer III frame length in bytes: (samplesPerFrame / 8) bytes of
  // audio per frame at the given bitrate, plus 1 byte when the padding bit is set.
  const frameLengthBytes = Math.floor(((samplesPerFrame / 8) * bitrateBps) / sampleRateHz) + padding;

  if (frameLengthBytes <= 4) return null;

  return { version, layer, bitrateKbps, sampleRateHz, samplesPerFrame, frameLengthBytes };
}
