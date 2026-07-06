import { UnprocessableEntityException } from '@nestjs/common';

import { decodeFrameHeader } from './frame-header-helper';
import { ID3V2_HEADER_SIZE_IN_BYTES, readId3v2Size } from './id3-tag-helper';
import { isVbrHeaderFrame, vbrProbeBytes } from './vbr-header-helper';

/**
 * A stateful, single-use frame counter fed one chunk at a time.
 * One instance per upload — never shared across requests.
 */
export interface FrameCounter {
  /** Feed the next chunk of bytes. */
  feed(chunk: Buffer): void;
  /** Finalize and return the frame count (throws 422 if no frames were found). */
  finalize(): number;
}

/** Phases of the streaming parse. */
type Phase = 'SKIP_ID3' | 'FIND_SYNC' | 'READ_HEADER';

/** ASCII "ID3" */
const ID3_MAGIC = [0x49, 0x44, 0x33];

/**
 * Streaming frame counter. Memory is O(1): `carry` only ever holds unconsumed
 * bytes (a partial header, or a frame being skipped) — never the whole file.
 * Only 4-byte headers are inspected; frame payload is skipped, not buffered.
 */
export class StreamingFrameCounter implements FrameCounter {
  private carry: Buffer = Buffer.alloc(0);
  /** Bytes still to discard: rest of an ID3v2 tag or a frame payload. */
  private skipRemaining = 0;
  private phase: Phase = 'SKIP_ID3';
  /** Set once trailing metadata / end-of-audio is reached; later chunks ignored. */
  private done = false;
  private frameCount = 0;

  feed(chunk: Buffer): void {
    if (this.done || chunk.length === 0) return;
    this.carry =
      this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    this.process();
  }

  finalize(): number {
    if (this.frameCount === 0) {
      throw new UnprocessableEntityException(
        'No MPEG audio frames found in file',
      );
    }
    return this.frameCount;
  }

  /**
   * Advance the parse over the bytes currently buffered in `carry`, called once
   * per {@link feed}. Runs the phases in order: finish any in-progress skip
   * (ID3 tag remainder or frame payload), skip a leading ID3v2 tag once, then
   * walk and count frame headers, hopping each frame's length.
   *
   * Consumes as much of `carry` as it can and returns early whenever it needs
   * more bytes to continue (a partial header, or a skip that spans into a later
   * chunk); the leftover bytes stay in `carry` for the next call. Returns for
   * good once end-of-audio is reached (`done`).
   */
  private process(): void {
    // 1) Finish any pending skip (ID3 tag remainder or frame payload) first.
    this.consumeSkip();
    if (this.skipRemaining > 0) return; // ran out of carry mid-skip → await more

    // 2) Skip a leading ID3v2 tag (runs once).
    if (this.phase === 'SKIP_ID3' && !this.skipLeadingId3()) return;

    // 3) Walk frame headers.
    while (this.carry.length >= 4) {
      const header = decodeFrameHeader(this.carry, 0);

      if (!header) {
        if (this.phase === 'FIND_SYNC') {
          this.carry = this.carry.subarray(1); // not locked on yet → resync scan
          continue;
        }
        this.done = true; // was counting → invalid header means end of audio
        return;
      }

      // The first frame may be a Xing/Info/VBRI header (VBR metadata, not audio).
      // Tools like mediainfo exclude it, so we skip it without counting.
      if (this.phase === 'FIND_SYNC') {
        const probe = Math.min(header.frameLengthBytes, vbrProbeBytes(header));
        if (this.carry.length < probe) return; // need more bytes to classify
        this.phase = 'READ_HEADER';
        if (!isVbrHeaderFrame(this.carry, 0, header)) {
          this.frameCount += 1;
        }
      } else {
        this.frameCount += 1;
      }

      this.skipRemaining = header.frameLengthBytes; // hop the whole frame
      this.consumeSkip();
      if (this.skipRemaining > 0) return; // frame continues in a later chunk
    }
  }

  /**
   * Detect and skip a leading ID3v2 tag. Returns `false` if it needs more bytes
   * (caller should return and wait), `true` when done (tag skipped or absent).
   */
  private skipLeadingId3(): boolean {
    if (this.carry.length < ID3_MAGIC.length) return false; // need magic bytes

    const looksLikeId3 = ID3_MAGIC.every((b, i) => this.carry[i] === b);
    if (looksLikeId3) {
      if (this.carry.length < ID3V2_HEADER_SIZE_IN_BYTES) return false; // need full header
      const id3 = readId3v2Size(this.carry);
      if (id3) {
        this.skipRemaining = id3.totalBytes;
        this.consumeSkip();
      }
    }

    this.phase = 'FIND_SYNC';
    return this.skipRemaining === 0; // false if the tag spans future chunks
  }

  /** Discard up to `skipRemaining` bytes from the front of `carry`. */
  private consumeSkip(): void {
    if (this.skipRemaining <= 0) return;
    const n = Math.min(this.skipRemaining, this.carry.length);
    this.skipRemaining -= n;
    this.carry = this.carry.subarray(n);
  }
}
