import {
  Box,
  childBoxes,
  malformed,
  payloadOf,
  readBoxes,
  UnsupportedVideoStructure,
  VideoStructureProblem
} from './iso-boxes';

/** Track handlers that carry pictures or sound; every other track is dropped. */
export const AUDIO_VIDEO_HANDLERS: ReadonlySet<string> = new Set([
  'vide',
  'soun'
]);

/** A run of consecutive samples of one track, as stored in the file. */
export interface ChunkRange {
  readonly offset: number;
  readonly size: number;
}

export interface TrackStructure {
  readonly box: Box;
  readonly children: Box[];
  readonly tkhd: Box;
  readonly trackId: number;
  readonly mdia: Box;
  readonly mdiaChildren: Box[];
  readonly mdhd: Box;
  /** The media handler (`mdia/hdlr`). */
  readonly hdlr: Box;
  readonly handler: string;
  readonly minf: Box | null;
  readonly minfChildren: Box[];
  readonly stbl: Box | null;
  readonly stblChildren: Box[];
  /** File offsets of the track's chunks, from `stco` or `co64`. */
  readonly chunkOffsets: number[];
}

export interface MovieStructure {
  /** The whole `moov` box. */
  readonly moov: Buffer;
  readonly children: Box[];
  readonly mvhd: Box;
  readonly tracks: TrackStructure[];
}

function required(boxes: Box[], type: string, parent: string): Box {
  const found = boxes.filter((box) => box.type === type);
  if (found.length !== 1) {
    throw malformed(`${parent} needs exactly one ${type}`);
  }
  return found[0];
}

function optional(boxes: Box[], type: string, parent: string): Box | null {
  const found = boxes.filter((box) => box.type === type);
  if (found.length > 1) throw malformed(`${parent} has more than one ${type}`);
  return found[0] ?? null;
}

/** `tkhd` track_ID: after version/flags and the two times. */
function readTrackId(moov: Buffer, tkhd: Box): number {
  const payload = payloadOf(moov, tkhd);
  const offset = payload[0] === 1 ? 20 : 12;
  if (payload.length < offset + 4) throw malformed('tkhd is truncated');
  return payload.readUInt32BE(offset);
}

/**
 * The handler type of an `hdlr`: an ISO handler_type and a QuickTime
 * component subtype share this offset.
 */
export function readHandlerType(moov: Buffer, hdlr: Box): string {
  const payload = payloadOf(moov, hdlr);
  if (payload.length < 24) throw malformed('hdlr is truncated');
  return payload.toString('latin1', 8, 12);
}

/** Chunk offsets from `stco` (32-bit) or `co64` (64-bit). */
function readChunkOffsets(moov: Buffer, stblChildren: Box[]): number[] {
  const stco = optional(stblChildren, 'stco', 'stbl');
  const co64 = optional(stblChildren, 'co64', 'stbl');
  const box = stco ?? co64;
  if (!box || (stco && co64)) {
    throw malformed('stbl needs exactly one of stco and co64');
  }
  const payload = payloadOf(moov, box);
  const width = box.type === 'co64' ? 8 : 4;
  if (payload.length < 8) throw malformed(`${box.type} is truncated`);
  const count = payload.readUInt32BE(4);
  if (payload.length < 8 + count * width) {
    throw malformed(`${box.type} is shorter than its entry count`);
  }
  const offsets = new Array<number>(count);
  for (let index = 0; index < count; index++) {
    const at = 8 + index * width;
    if (width === 4) {
      offsets[index] = payload.readUInt32BE(at);
      continue;
    }
    const high = payload.readUInt32BE(at);
    if (high > 0x1fffff) throw malformed('co64 offset out of range');
    offsets[index] = high * 0x100000000 + payload.readUInt32BE(at + 4);
  }
  return offsets;
}

const ENCRYPTION_BOXES = new Set(['saiz', 'saio', 'senc']);

function parseTrack(moov: Buffer, box: Box): TrackStructure {
  const children = childBoxes(moov, box);
  const tkhd = required(children, 'tkhd', 'trak');
  const mdia = required(children, 'mdia', 'trak');
  const mdiaChildren = childBoxes(moov, mdia);
  const mdhd = required(mdiaChildren, 'mdhd', 'mdia');
  const hdlr = required(mdiaChildren, 'hdlr', 'mdia');
  const minf = optional(mdiaChildren, 'minf', 'mdia');
  const minfChildren = minf ? childBoxes(moov, minf) : [];
  const stbl = optional(minfChildren, 'stbl', 'minf');
  const stblChildren = stbl ? childBoxes(moov, stbl) : [];
  return {
    box,
    children,
    tkhd,
    trackId: readTrackId(moov, tkhd),
    mdia,
    mdiaChildren,
    mdhd,
    hdlr,
    handler: readHandlerType(moov, hdlr),
    minf,
    minfChildren,
    stbl,
    stblChildren,
    chunkOffsets: stbl ? readChunkOffsets(moov, stblChildren) : []
  };
}

/** Parses a whole `moov` box into its header and tracks. */
export function parseMovie(moov: Buffer): MovieStructure {
  const [moovBox] = readBoxes(moov, 0, moov.length);
  if (moovBox?.type !== 'moov' || moovBox.end !== moov.length) {
    throw malformed('expected a single moov box');
  }
  const children = childBoxes(moov, moovBox);
  if (children.some((box) => box.type === 'mvex')) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.FRAGMENTED,
      'moov has mvex'
    );
  }
  if (children.some((box) => box.type === 'cmov')) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.COMPRESSED_MOVIE,
      'moov has cmov'
    );
  }
  const tracks = children
    .filter((box) => box.type === 'trak')
    .map((box) => parseTrack(moov, box));
  const ids = tracks.map((track) => track.trackId);
  if (new Set(ids).size !== ids.length) throw malformed('duplicate track ids');
  return {
    moov,
    children,
    mvhd: required(children, 'mvhd', 'moov'),
    tracks
  };
}

export interface DataReferences {
  readonly entries: Box[];
  /** An entry points at another file (its samples are not in this one). */
  readonly external: boolean;
  /** An entry carries data, such as a path or URL. */
  readonly withData: boolean;
}

/** The entries of a `dref`; a self-contained entry has flag 1 and no data. */
export function readDataReferences(moov: Buffer, dref: Box): DataReferences {
  const payload = payloadOf(moov, dref);
  if (payload.length < 8) throw malformed('dref is truncated');
  const entries = readBoxes(payload, 8, payload.length);
  let external = false;
  let withData = false;
  for (const entry of entries) {
    const length = entry.end - entry.payloadStart;
    if (length < 4 || (payload[entry.payloadStart + 3] & 1) === 0) {
      external = true;
    }
    if (length > 4) withData = true;
  }
  return { entries, external, withData };
}

/** Refuses tracks whose samples are stored in another file. */
export function assertSelfContained(moov: Buffer, track: TrackStructure): void {
  const dinf = optional(track.minfChildren, 'dinf', 'minf');
  const dref = dinf ? optional(childBoxes(moov, dinf), 'dref', 'dinf') : null;
  if (dref && readDataReferences(moov, dref).external) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.EXTERNAL_DATA_REFERENCE,
      `track ${track.trackId} refers to another file`
    );
  }
}

export function isAudioVideoTrack(track: TrackStructure): boolean {
  return AUDIO_VIDEO_HANDLERS.has(track.handler);
}

/** Sample entry types (codecs) of a track's `stsd`. */
export function sampleEntryTypes(
  moov: Buffer,
  track: TrackStructure
): string[] {
  const stsd = optional(track.stblChildren, 'stsd', 'stbl');
  if (!stsd) return [];
  const payload = payloadOf(moov, stsd);
  if (payload.length < 8) throw malformed('stsd is truncated');
  return readBoxes(payload, 8, payload.length).map((entry) => entry.type);
}

interface SampleToChunkRun {
  readonly firstChunk: number;
  readonly samplesPerChunk: number;
}

function readSampleToChunk(moov: Buffer, stsc: Box): SampleToChunkRun[] {
  const payload = payloadOf(moov, stsc);
  if (payload.length < 8) throw malformed('stsc is truncated');
  const count = payload.readUInt32BE(4);
  if (payload.length < 8 + count * 12) {
    throw malformed('stsc is shorter than its entry count');
  }
  const runs: SampleToChunkRun[] = [];
  for (let index = 0; index < count; index++) {
    const at = 8 + index * 12;
    const run = {
      firstChunk: payload.readUInt32BE(at),
      samplesPerChunk: payload.readUInt32BE(at + 4)
    };
    const previous = runs[runs.length - 1];
    if (
      run.samplesPerChunk === 0 ||
      (previous ? run.firstChunk <= previous.firstChunk : run.firstChunk !== 1)
    ) {
      throw malformed('stsc runs are out of order');
    }
    runs.push(run);
  }
  return runs;
}

interface SampleSizes {
  /** Non-zero when every sample has this size. */
  readonly constant: number;
  readonly count: number;
  readonly table: Buffer;
}

function readSampleSizes(moov: Buffer, stsz: Box): SampleSizes {
  const payload = payloadOf(moov, stsz);
  if (payload.length < 12) throw malformed('stsz is truncated');
  const constant = payload.readUInt32BE(4);
  const count = payload.readUInt32BE(8);
  if (constant === 0 && payload.length < 12 + count * 4) {
    throw malformed('stsz is shorter than its sample count');
  }
  return { constant, count, table: payload.subarray(12) };
}

function unsupportedTable(detail: string): UnsupportedVideoStructure {
  return new UnsupportedVideoStructure(
    VideoStructureProblem.UNSUPPORTED_SAMPLE_TABLE,
    detail
  );
}

/** Refuses sample tables whose bytes per chunk do not follow from sizes. */
function assertSupportedSampleTable(track: TrackStructure): void {
  const types = track.stblChildren.map((box) => box.type);
  if (types.includes('stz2')) throw unsupportedTable('compact sample sizes');
  if (types.some((type) => ENCRYPTION_BOXES.has(type))) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.ENCRYPTED,
      'sample encryption data'
    );
  }
}

/**
 * The byte range of each chunk of an audio/video track, in chunk (decode)
 * order: its offset and the sum of its samples' sizes. QuickTime sound with
 * a constant 1-byte sample size counts audio frames, not bytes, so its chunk
 * sizes cannot be derived here and it is refused.
 */
export function chunkRanges(moov: Buffer, track: TrackStructure): ChunkRange[] {
  assertSupportedSampleTable(track);
  const stsc = required(track.stblChildren, 'stsc', 'stbl');
  const stsz = required(track.stblChildren, 'stsz', 'stbl');
  const runs = readSampleToChunk(moov, stsc);
  const sizes = readSampleSizes(moov, stsz);
  if (sizes.constant === 1 && track.handler === 'soun') {
    throw unsupportedTable('sound with 1-byte sample sizes');
  }
  const offsets = track.chunkOffsets;
  if (runs.length && runs[runs.length - 1].firstChunk > offsets.length) {
    throw malformed('stsc refers to chunks that do not exist');
  }
  const ranges = new Array<ChunkRange>(offsets.length);
  let sample = 0;
  let run = 0;
  for (let chunk = 0; chunk < offsets.length; chunk++) {
    while (run + 1 < runs.length && runs[run + 1].firstChunk <= chunk + 1) {
      run++;
    }
    const count = runs[run]?.samplesPerChunk;
    if (count === undefined || sample + count > sizes.count) {
      throw malformed('chunks hold more samples than stsz lists');
    }
    let size = count * sizes.constant;
    if (!sizes.constant) {
      for (let index = sample; index < sample + count; index++) {
        size += sizes.table.readUInt32BE(index * 4);
      }
    }
    sample += count;
    ranges[chunk] = { offset: offsets[chunk], size };
  }
  if (sample !== sizes.count) {
    throw malformed('stsz lists samples that no chunk holds');
  }
  return ranges;
}
