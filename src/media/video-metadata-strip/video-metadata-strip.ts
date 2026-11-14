import { FileHandle, open } from 'node:fs/promises';
import {
  Box,
  buildBox,
  childBoxes,
  copyBox,
  malformed,
  payloadOf,
  payloadWithoutTimes,
  readExactly,
  UnsupportedVideoStructure,
  VideoStructureProblem
} from './iso-boxes';
import { coalesceRanges, copyRanges, writeAt } from './media-ranges';
import { readDataReferences, TrackStructure } from './movie-structure';
import {
  findIdentifyingMetadata,
  KEPT_CHILDREN,
  VideoMetadataFinding
} from './video-metadata-policy';
import { VideoLayout, readVideoLayout } from './video-layout';

export type VideoStripResult =
  /** Nothing identifying: the file is left exactly as it is. */
  | { readonly kind: 'clean'; readonly size: number }
  | {
      readonly kind: 'stripped';
      readonly findings: VideoMetadataFinding[];
      readonly inputBytes: number;
      readonly outputBytes: number;
      /** Handler types of the removed tracks, for logs and reports. */
      readonly removedTracks: string[];
    }
  | {
      readonly kind: 'unsupported';
      readonly problem: VideoStructureProblem;
      readonly detail: string;
    };

/** Removed top-level boxes up to this size are read to name what they hold. */
const MAX_INSPECTED_TOP_LEVEL_BYTES = 1024 * 1024;

/** The box with its creation and modification times at zero. */
function zeroTimes(moov: Buffer, box: Box): Buffer {
  return buildBox(box.type, [payloadWithoutTimes(moov, box)]);
}

/**
 * The `hdlr` with an empty name. One NUL byte is an empty C string (ISO)
 * and an empty counted string (QuickTime), so both readers agree.
 */
function emptyHandlerName(moov: Buffer, box: Box): Buffer {
  const payload = payloadOf(moov, box);
  if (payload.length < 24) throw malformed('hdlr is truncated');
  return buildBox(box.type, [payload.subarray(0, 24), Buffer.alloc(1)]);
}

/** Self-contained data references without any data in them. */
function canonicalDataInformation(moov: Buffer, dinf: Box): Buffer | null {
  const dref = childBoxes(moov, dinf).find((box) => box.type === 'dref');
  if (!dref) return null;
  const { entries } = readDataReferences(moov, dref);
  const payload = payloadOf(moov, dref);
  const head = Buffer.alloc(8);
  payload.copy(head, 0, 0, 4);
  head.writeUInt32BE(entries.length, 4);
  const rebuilt = entries.map((entry) =>
    buildBox(entry.type, [Buffer.from([payload[entry.payloadStart], 0, 0, 1])])
  );
  return buildBox('dinf', [buildBox('dref', [head, ...rebuilt])]);
}

/** Track references, keeping only those to kept tracks (never chapters). */
function filteredReferences(
  moov: Buffer,
  tref: Box,
  keptIds: ReadonlySet<number>
): Buffer | null {
  const kept: Buffer[] = [];
  for (const reference of childBoxes(moov, tref)) {
    if (reference.type === 'chap') continue;
    const payload = payloadOf(moov, reference);
    const ids: number[] = [];
    for (let at = 0; at + 4 <= payload.length; at += 4) {
      const id = payload.readUInt32BE(at);
      if (keptIds.has(id)) ids.push(id);
    }
    if (!ids.length) continue;
    const body = Buffer.alloc(ids.length * 4);
    ids.forEach((id, index) => body.writeUInt32BE(id, index * 4));
    kept.push(buildBox(reference.type, [body]));
  }
  return kept.length ? buildBox('tref', kept) : null;
}

function chunkOffsetBox(type: string, version: Buffer, offsets: number[]) {
  const width = type === 'co64' ? 8 : 4;
  const body = Buffer.alloc(8 + offsets.length * width);
  version.copy(body, 0, 0, 4);
  body.writeUInt32BE(offsets.length, 4);
  offsets.forEach((offset, index) => {
    const at = 8 + index * width;
    if (width === 4) {
      if (offset > 0xffffffff) throw malformed('offset exceeds stco range');
      body.writeUInt32BE(offset, at);
      return;
    }
    body.writeUInt32BE(Math.floor(offset / 0x100000000), at);
    body.writeUInt32BE(offset % 0x100000000, at + 4);
  });
  return buildBox(type, [body]);
}

interface TrackRewrite {
  readonly track: TrackStructure;
  readonly offsets: number[];
}

/** Keeps the allowed children of `parent`, mapping each through `rebuild`. */
function rebuildChildren(
  moov: Buffer,
  parent: Box,
  rebuild: (child: Box) => Buffer | null
): Buffer {
  const allowed = KEPT_CHILDREN[parent.type];
  const parts = childBoxes(moov, parent)
    .filter((child) => allowed.has(child.type))
    .map(rebuild)
    .filter((part): part is Buffer => part !== null);
  return buildBox(parent.type, parts);
}

function rebuildSampleTable(moov: Buffer, stbl: Box, offsets: number[]) {
  return rebuildChildren(moov, stbl, (child) =>
    child.type === 'stco' || child.type === 'co64'
      ? chunkOffsetBox(child.type, payloadOf(moov, child), offsets)
      : copyBox(moov, child)
  );
}

function rebuildMediaInformation(moov: Buffer, minf: Box, offsets: number[]) {
  return rebuildChildren(moov, minf, (child) => {
    if (child.type === 'hdlr') return emptyHandlerName(moov, child);
    if (child.type === 'dinf') return canonicalDataInformation(moov, child);
    if (child.type === 'stbl') return rebuildSampleTable(moov, child, offsets);
    return copyBox(moov, child);
  });
}

function rebuildMedia(moov: Buffer, mdia: Box, offsets: number[]): Buffer {
  return rebuildChildren(moov, mdia, (child) => {
    if (child.type === 'mdhd') return zeroTimes(moov, child);
    if (child.type === 'hdlr') return emptyHandlerName(moov, child);
    return rebuildMediaInformation(moov, child, offsets);
  });
}

function rebuildTrack(
  moov: Buffer,
  { track, offsets }: TrackRewrite,
  keptIds: ReadonlySet<number>
): Buffer {
  return rebuildChildren(moov, track.box, (child) => {
    switch (child.type) {
      case 'tkhd':
        return zeroTimes(moov, child);
      case 'tref':
        return filteredReferences(moov, child, keptIds);
      case 'edts': {
        const edits = rebuildChildren(moov, child, (edit) =>
          copyBox(moov, edit)
        );
        return edits.length > 8 ? edits : null;
      }
      case 'mdia':
        return rebuildMedia(moov, child, offsets);
      default:
        return copyBox(moov, child);
    }
  });
}

/** The stripped `moov`: kept tracks, zeroed times and new chunk offsets. */
function rebuildMovie(layout: VideoLayout, rewrites: TrackRewrite[]): Buffer {
  const { moov, children } = layout.movie;
  const byTrak = new Map(
    rewrites.map((rewrite) => [rewrite.track.box.start, rewrite])
  );
  const keptIds = new Set(rewrites.map((rewrite) => rewrite.track.trackId));
  const parts: Buffer[] = [];
  for (const child of children) {
    if (child.type === 'mvhd') parts.push(zeroTimes(moov, child));
    const rewrite = child.type === 'trak' ? byTrak.get(child.start) : undefined;
    if (rewrite) parts.push(rebuildTrack(moov, rewrite, keptIds));
  }
  return buildBox('moov', parts);
}

interface PlacedChunk {
  readonly track: number;
  readonly chunk: number;
  readonly offset: number;
  readonly size: number;
}

/**
 * Kept chunks in their original file order, so audio and video stay
 * interleaved as they were.
 */
function placeChunks(layout: VideoLayout): PlacedChunk[] {
  return layout.kept
    .flatMap(({ chunks }, track) =>
      chunks.map((range, chunk) => ({ track, chunk, ...range }))
    )
    .sort(
      (a, b) => a.offset - b.offset || a.track - b.track || a.chunk - b.chunk
    );
}

function mediaDataHeader(payloadSize: number): Buffer {
  if (payloadSize + 8 <= 0xffffffff) {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(payloadSize + 8, 0);
    header.write('mdat', 4, 4, 'latin1');
    return header;
  }
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write('mdat', 4, 4, 'latin1');
  const size = payloadSize + 16;
  header.writeUInt32BE(Math.floor(size / 0x100000000), 8);
  header.writeUInt32BE(size % 0x100000000, 12);
  return header;
}

/**
 * Writes `ftyp`, the stripped `moov` and one `mdat` holding only the kept
 * tracks' samples, byte for byte. The movie header goes first, so the file
 * can start playing before it has fully downloaded.
 */
async function writeStrippedFile(
  input: FileHandle,
  layout: VideoLayout,
  outputPath: string
): Promise<number> {
  const placed = placeChunks(layout);
  const payloadSize = placed.reduce((total, chunk) => total + chunk.size, 0);
  const mdatHeader = mediaDataHeader(payloadSize);
  const ftyp = layout.ftyp
    ? await readExactly(
        input,
        layout.ftyp.start,
        layout.ftyp.end - layout.ftyp.start
      )
    : Buffer.alloc(0);
  const rewrites = layout.kept.map(({ track, chunks }) => ({
    track,
    offsets: new Array<number>(chunks.length).fill(0)
  }));
  const place = (base: number) => {
    let position = base;
    for (const chunk of placed) {
      rewrites[chunk.track].offsets[chunk.chunk] = position;
      position += chunk.size;
    }
  };
  // Box sizes do not depend on offset values: size the header, then fill it.
  const draft = rebuildMovie(layout, rewrites);
  place(ftyp.length + draft.length + mdatHeader.length);
  const moov = rebuildMovie(layout, rewrites);
  if (moov.length !== draft.length) throw new Error('moov size changed');
  const output = await open(outputPath, 'wx');
  try {
    let position = await writeAt(output, ftyp, 0);
    position = await writeAt(output, moov, position);
    position = await writeAt(output, mdatHeader, position);
    return await copyRanges(input, output, coalesceRanges(placed), position);
  } finally {
    await output.close();
  }
}

/** Removed top-level boxes small enough to name what they hold. */
async function readSmallTopLevelBoxes(
  input: FileHandle,
  layout: VideoLayout
): Promise<Map<number, Buffer>> {
  const bytes = new Map<number, Buffer>();
  for (const box of layout.topLevel) {
    const size = box.end - box.start;
    if (['mdat', 'moov', 'ftyp'].includes(box.type)) continue;
    if (size <= MAX_INSPECTED_TOP_LEVEL_BYTES) {
      bytes.set(box.start, await readExactly(input, box.start, size));
    }
  }
  return bytes;
}

/**
 * Reads an MP4 or QuickTime file and, when it carries identifying data,
 * writes a copy to `outputPath` that keeps only the audio and video tracks:
 * their sample descriptions (codecs, colour, HDR), edit lists, display
 * matrices (rotation) and sample tables unchanged, their sample bytes copied
 * verbatim, every time zeroed and every handler name emptied. User data,
 * metadata, vendor boxes and all other tracks are dropped, including their
 * samples. Unsupported structures are reported, never guessed at.
 */
export async function stripVideoMetadataFile(
  inputPath: string,
  outputPath: string
): Promise<VideoStripResult> {
  const input = await open(inputPath, 'r');
  try {
    const { size } = await input.stat();
    const layout = await readVideoLayout(input, size);
    const { findings } = findIdentifyingMetadata(
      layout,
      await readSmallTopLevelBoxes(input, layout)
    );
    if (!findings.length) return { kind: 'clean', size };
    const outputBytes = await writeStrippedFile(input, layout, outputPath);
    return {
      kind: 'stripped',
      findings,
      inputBytes: size,
      outputBytes,
      removedTracks: layout.dropped.map((track) => track.handler)
    };
  } catch (error) {
    if (error instanceof UnsupportedVideoStructure) {
      return {
        kind: 'unsupported',
        problem: error.problem,
        detail: error.message
      };
    }
    throw error;
  } finally {
    await input.close();
  }
}
