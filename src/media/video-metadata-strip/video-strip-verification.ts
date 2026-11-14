import { FileHandle, open } from 'node:fs/promises';
import {
  Box,
  childBoxes,
  payloadWithoutTimes,
  readExactly,
  UnsupportedVideoStructure
} from './iso-boxes';
import { hashRanges } from './media-ranges';
import { sampleEntryTypes } from './movie-structure';
import { findIdentifyingMetadata } from './video-metadata-policy';
import { KeptTrack, readVideoLayout, VideoLayout } from './video-layout';

export interface VerifiedTrack {
  readonly handler: string;
  readonly codecs: string[];
  readonly chunks: number;
  readonly bytes: number;
  /** SHA-256 of the track's sample bytes in decode order. */
  readonly sha256: string;
}

export type VideoStripVerification =
  | { readonly ok: true; readonly tracks: VerifiedTrack[] }
  | { readonly ok: false; readonly reason: string };

class VerificationFailure extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'VerificationFailure';
  }
}

function check(condition: boolean, reason: string): void {
  if (!condition) throw new VerificationFailure(reason);
}

async function openLayout(file: FileHandle): Promise<VideoLayout> {
  return readVideoLayout(file, (await file.stat()).size);
}

/** The output is exactly `ftyp` (if the input had one), `moov`, `mdat`. */
function checkOutputShape(before: VideoLayout, after: VideoLayout): void {
  const types = after.topLevel.map((box) => box.type).join(',');
  const expected = before.ftyp ? 'ftyp,moov,mdat' : 'moov,mdat';
  check(types === expected, `output boxes are ${types}, not ${expected}`);
  check(after.dropped.length === 0, 'output has non-audio/video tracks');
}

function boxBytes(moov: Buffer, box: Box | undefined): Buffer | null {
  return box ? moov.subarray(box.start, box.end) : null;
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null ? b === null : b !== null && a.equals(b);
}

function sameWithoutTimes(
  before: Buffer,
  beforeBox: Box,
  after: Buffer,
  afterBox: Box
): boolean {
  return payloadWithoutTimes(before, beforeBox).equals(
    payloadWithoutTimes(after, afterBox)
  );
}

function editList(moov: Buffer, kept: KeptTrack): Buffer | null {
  const edts = kept.track.children.find((box) => box.type === 'edts');
  const elst = edts
    ? childBoxes(moov, edts).find((box) => box.type === 'elst')
    : undefined;
  return boxBytes(moov, elst);
}

/**
 * Same track, same display matrix and size (rotation), same timescale and
 * duration, same sample description (codecs, colour, HDR) and the same
 * sample tables apart from the chunk offsets, which moved with the data.
 */
function checkTrackHeaders(
  before: VideoLayout,
  after: VideoLayout,
  index: number
): void {
  const a = before.kept[index];
  const b = after.kept[index];
  const label = `track ${a.track.trackId}`;
  const moovA = before.movie.moov;
  const moovB = after.movie.moov;
  check(
    a.track.trackId === b.track.trackId && a.track.handler === b.track.handler,
    `${label} changed identity`
  );
  check(
    sameWithoutTimes(moovA, a.track.tkhd, moovB, b.track.tkhd),
    `${label} header (matrix, size or duration) changed`
  );
  check(
    sameWithoutTimes(moovA, a.track.mdhd, moovB, b.track.mdhd),
    `${label} media timescale or duration changed`
  );
  check(
    sameBytes(editList(moovA, a), editList(moovB, b)),
    `${label} edit list changed`
  );
  for (const table of b.track.stblChildren) {
    if (table.type === 'stco' || table.type === 'co64') continue;
    const original = a.track.stblChildren.find(
      (box) => box.type === table.type
    );
    check(
      sameBytes(boxBytes(moovA, original), boxBytes(moovB, table)),
      `${label} ${table.type} changed`
    );
  }
  check(
    b.track.stblChildren.some((box) => box.type === 'stsd'),
    `${label} lost its sample description`
  );
}

async function checkSamples(
  input: FileHandle,
  output: FileHandle,
  before: VideoLayout,
  after: VideoLayout
): Promise<VerifiedTrack[]> {
  const tracks: VerifiedTrack[] = [];
  for (let index = 0; index < before.kept.length; index++) {
    const a = before.kept[index];
    const b = after.kept[index];
    check(a.chunks.length === b.chunks.length, 'chunk count changed');
    const [hashA, hashB] = [
      await hashRanges(input, a.chunks),
      await hashRanges(output, b.chunks)
    ];
    check(hashA === hashB, `track ${a.track.trackId} sample bytes changed`);
    tracks.push({
      handler: b.track.handler,
      codecs: sampleEntryTypes(after.movie.moov, b.track),
      chunks: b.chunks.length,
      bytes: b.chunks.reduce((total, chunk) => total + chunk.size, 0),
      sha256: hashB
    });
  }
  return tracks;
}

async function checkFileType(
  input: FileHandle,
  output: FileHandle,
  before: VideoLayout,
  after: VideoLayout
): Promise<void> {
  if (!before.ftyp || !after.ftyp) return;
  const brands = (file: FileHandle, box: Box) =>
    readExactly(file, box.payloadStart, box.end - box.payloadStart);
  const a = await brands(input, before.ftyp);
  const b = await brands(output, after.ftyp);
  check(a.equals(b), 'file type brands changed');
}

/**
 * Checks a stripped file against its original, reading both from disk and
 * parsing the output afresh:
 * - the output holds only `ftyp`, `moov` and `mdat`, and nothing in it is
 *   outside the kept-box policy: no `udta`, `meta`, `uuid`, `©xyz` or Apple
 *   location keys, no telemetry, timecode or text tracks, no handler names,
 *   zero creation and modification times, and no long location strings
 *   anywhere in the movie header;
 * - the media data holds the kept samples and nothing else, with no gaps;
 * - the same audio/video tracks remain, with unchanged movie and track
 *   headers apart from times (duration, timescale, display matrix), sample
 *   descriptions and sample tables;
 * - each track's sample bytes hash the same as the original's.
 */
export async function verifyVideoStrip(
  inputPath: string,
  outputPath: string
): Promise<VideoStripVerification> {
  const input = await open(inputPath, 'r');
  const output = await open(outputPath, 'r').catch(async (error: unknown) => {
    await input.close();
    throw error;
  });
  try {
    const before = await openLayout(input);
    const after = await openLayout(output);
    checkOutputShape(before, after);
    const { problems } = findIdentifyingMetadata(after);
    check(!problems.length, `metadata remains: ${problems.join('; ')}`);
    check(
      before.kept.length === after.kept.length,
      'audio/video track count changed'
    );
    check(
      sameWithoutTimes(
        before.movie.moov,
        before.movie.mvhd,
        after.movie.moov,
        after.movie.mvhd
      ),
      'movie timescale or duration changed'
    );
    before.kept.forEach((_, index) => checkTrackHeaders(before, after, index));
    await checkFileType(input, output, before, after);
    return {
      ok: true,
      tracks: await checkSamples(input, output, before, after)
    };
  } catch (error) {
    if (error instanceof VerificationFailure) {
      return { ok: false, reason: error.message };
    }
    if (error instanceof UnsupportedVideoStructure) {
      return { ok: false, reason: `unreadable: ${error.message}` };
    }
    throw error;
  } finally {
    await Promise.all([input.close(), output.close()]);
  }
}
