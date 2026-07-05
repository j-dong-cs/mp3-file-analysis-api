/**
 * Pure ID3v2 tag inspection helper.
 *
 * This module is used to read the ID3v2 tag from an MP3 file. 
 * MP3 files often begin with an ID3v2 metadata tag that must be skipped before
 * the audio frames start.
 */

/** Bytes needed to read the ID3v2 header (magic + version + flags + size). */
export const ID3V2_HEADER_SIZE_IN_BYTES = 10;

export interface Id3v2Info {
  /** Total bytes to skip: 10-byte header + declared size (+ 10 for a footer). */
  totalBytes: number;
}

/**
 * If `buf` starts with an ID3v2 tag, return how many bytes to skip; otherwise
 * `null`. Requires at least {@link ID3V2_HEADER_SIZE_IN_BYTES} bytes to read the size.
 */
export function readId3v2Size(buf: Buffer): Id3v2Info | null {
  if (buf.length < ID3V2_HEADER_SIZE_IN_BYTES) return null;

  // Magic: ASCII "ID3".
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return null;

  // Footer flag (bit 4 of the flags byte) adds a trailing 10-byte footer.
  const hasFooter = (buf[5] & 0x10) !== 0;

  // 28-bit synchsafe size: 7 usable bits per byte, high bit always 0.
  const size =
    ((buf[6] & 0x7f) << 21) |
    ((buf[7] & 0x7f) << 14) |
    ((buf[8] & 0x7f) << 7) |
    (buf[9] & 0x7f);

  return { totalBytes: ID3V2_HEADER_SIZE_IN_BYTES + size + (hasFooter ? 10 : 0) };
}
