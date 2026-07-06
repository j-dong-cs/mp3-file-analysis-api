/**
 * Detects the VBR/encoder info header frame (Xing / Info / VBRI).
 *
 * Encoders place a structurally-valid MPEG frame at the very start of the audio
 * that carries VBR seek tables + encoder info (LAME) rather than audio. Tools
 * like `mediainfo` do not count it as an audio frame, so we skip it too.
 * Only the first frame of a stream is ever one of these.
 */

import type { DecodedFrameHeader } from './frame-header-helper';

/** Side-information block size (bytes) between the 4-byte header and the tag. */
function sideInfoSize(header: DecodedFrameHeader): number {
  // MPEG-1: 17 bytes (mono) or 32 bytes (stereo / joint / dual channel).
  return header.isMono ? 17 : 32;
}

function hasAscii(buf: Buffer, offset: number, marker: string): boolean {
  if (offset < 0 || offset + marker.length > buf.length) return false;
  for (let i = 0; i < marker.length; i++) {
    if (buf[offset + i] !== marker.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Bytes of the frame needed to decide whether it is a VBR header frame — the
 * counter waits until it has this many buffered before classifying the first
 * frame. Xing/Info sits at `4 + sideInfo`; VBRI is fixed at offset 36.
 */
export function vbrProbeBytes(header: DecodedFrameHeader): number {
  return Math.max(4 + sideInfoSize(header), 36) + 4;
}

/**
 * True if the frame at `buf[offset]` is a Xing/Info/VBRI header frame (metadata,
 * not audio). `header` is the already-decoded header for that frame.
 */
export function isVbrHeaderFrame(
  buf: Buffer,
  offset: number,
  header: DecodedFrameHeader,
): boolean {
  const tagOffset = offset + 4 + sideInfoSize(header);
  if (hasAscii(buf, tagOffset, 'Xing') || hasAscii(buf, tagOffset, 'Info')) {
    return true;
  }
  // VBRI (Fraunhofer) is always 32 bytes after the 4-byte header.
  return hasAscii(buf, offset + 36, 'VBRI');
}
