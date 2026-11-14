import { FileHandle } from 'node:fs/promises';
import {
  Box,
  malformed,
  readExactly,
  readTopLevelBoxes,
  UnsupportedVideoStructure,
  VideoStructureProblem
} from './iso-boxes';
import {
  assertSelfContained,
  ChunkRange,
  chunkRanges,
  isAudioVideoTrack,
  MovieStructure,
  parseMovie,
  TrackStructure
} from './movie-structure';

/**
 * The movie header is read into memory. Its sample tables grow with the
 * number of samples; 64 MiB is far above any 500 MiB upload's.
 */
export const MAX_MOVIE_HEADER_BYTES = 64 * 1024 * 1024;

/** First box types an MP4 or QuickTime file may start with. */
const LEADING_BOX_TYPES = new Set([
  'ftyp',
  'moov',
  'mdat',
  'wide',
  'free',
  'skip',
  'pnot',
  'uuid'
]);

export interface KeptTrack {
  readonly track: TrackStructure;
  /** Chunk byte ranges in decode order. */
  readonly chunks: ChunkRange[];
}

/** Where everything in one MP4/QuickTime file is. */
export interface VideoLayout {
  readonly fileSize: number;
  readonly topLevel: Box[];
  readonly ftyp: Box | null;
  readonly movie: MovieStructure;
  /** Audio and video tracks, in file order. */
  readonly kept: KeptTrack[];
  /** Every other track (telemetry, timecode, text, chapters, ...). */
  readonly dropped: TrackStructure[];
  /** Payload ranges of the `mdat` boxes. */
  readonly mediaData: ChunkRange[];
  /**
   * Media data bytes no audio/video sample uses (other tracks' samples,
   * padding, leftovers) plus data appended after the last box. They are
   * never copied.
   */
  readonly unreferencedBytes: number;
}

async function assertIsoMedia(file: FileHandle, fileSize: number) {
  if (fileSize < 8) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.NOT_ISO_MEDIA,
      'file is too short'
    );
  }
  const head = await readExactly(file, 0, 8);
  const type = head.toString('latin1', 4, 8);
  if (!LEADING_BOX_TYPES.has(type)) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.NOT_ISO_MEDIA,
      'no MP4 or QuickTime box at the start'
    );
  }
}

/** The single box of a type, or null; more than one is malformed. */
function single(boxes: Box[], type: string): Box | null {
  const found = boxes.filter((box) => box.type === type);
  if (found.length > 1) throw malformed(`more than one top-level ${type}`);
  return found[0] ?? null;
}

/**
 * Every chunk lies inside one media data range. Both lists are sorted by
 * offset (top-level boxes are in file order), so one sweep checks them all.
 */
function assertInsideMediaData(
  sortedChunks: ChunkRange[],
  mediaData: ChunkRange[]
): void {
  let index = 0;
  for (const chunk of sortedChunks) {
    while (
      index < mediaData.length &&
      mediaData[index].offset + mediaData[index].size <= chunk.offset
    ) {
      index++;
    }
    const range = mediaData[index];
    if (
      !range ||
      chunk.offset < range.offset ||
      chunk.offset + chunk.size > range.offset + range.size
    ) {
      throw malformed('a sample lies outside the media data');
    }
  }
}

function compareOffsets(a: ChunkRange, b: ChunkRange): number {
  return a.offset - b.offset;
}

/**
 * Every kept chunk lies inside media data, kept chunks do not overlap, and no
 * other track's chunk starts inside a kept one. Otherwise the sizes were not
 * read the way the file was written, and copying them could carry another
 * track's bytes along.
 */
function assertChunksAreDisjoint(
  kept: KeptTrack[],
  dropped: TrackStructure[],
  mediaData: ChunkRange[]
): void {
  const chunks = kept
    .flatMap((track) => track.chunks)
    .filter((chunk) => chunk.size > 0)
    .sort(compareOffsets);
  assertInsideMediaData(chunks, mediaData);
  chunks.forEach((chunk, index) => {
    const next = chunks[index + 1];
    if (next && next.offset < chunk.offset + chunk.size) {
      throw new UnsupportedVideoStructure(
        VideoStructureProblem.UNSUPPORTED_SAMPLE_TABLE,
        'audio/video chunks overlap'
      );
    }
  });
  const otherStarts = dropped
    .flatMap((track) => track.chunkOffsets)
    .sort((a, b) => a - b);
  for (const chunk of chunks) {
    if (startsInside(otherStarts, chunk)) {
      throw new UnsupportedVideoStructure(
        VideoStructureProblem.UNSUPPORTED_SAMPLE_TABLE,
        'another track starts inside an audio/video chunk'
      );
    }
  }
}

/** Binary search: is any sorted offset strictly inside the chunk? */
function startsInside(sorted: number[], chunk: ChunkRange): boolean {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= chunk.offset) low = middle + 1;
    else high = middle;
  }
  return low < sorted.length && sorted[low] < chunk.offset + chunk.size;
}

/** Reads the box layout and sample tables of an MP4 or QuickTime file. */
export async function readVideoLayout(
  file: FileHandle,
  fileSize: number
): Promise<VideoLayout> {
  await assertIsoMedia(file, fileSize);
  const { boxes: topLevel, trailingBytes } = await readTopLevelBoxes(
    file,
    fileSize
  );
  const moovBox = single(topLevel, 'moov');
  if (!moovBox) throw malformed('no moov box');
  const moovSize = moovBox.end - moovBox.start;
  if (moovSize > MAX_MOVIE_HEADER_BYTES) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.MOVIE_HEADER_TOO_LARGE,
      `moov is ${moovSize} bytes`
    );
  }
  const movie = parseMovie(await readExactly(file, moovBox.start, moovSize));
  const kept = movie.tracks.filter(isAudioVideoTrack).map((track) => {
    assertSelfContained(movie.moov, track);
    return { track, chunks: chunkRanges(movie.moov, track) };
  });
  if (!kept.length) {
    throw new UnsupportedVideoStructure(
      VideoStructureProblem.NO_AUDIO_VIDEO_TRACKS,
      'no audio or video track'
    );
  }
  const dropped = movie.tracks.filter((track) => !isAudioVideoTrack(track));
  const mediaData = topLevel
    .filter((box) => box.type === 'mdat')
    .map((box) => ({
      offset: box.payloadStart,
      size: box.end - box.payloadStart
    }));
  assertChunksAreDisjoint(kept, dropped, mediaData);
  const mediaBytes = mediaData.reduce((total, range) => total + range.size, 0);
  const keptBytes = kept
    .flatMap((track) => track.chunks)
    .reduce((total, chunk) => total + chunk.size, 0);
  return {
    fileSize,
    topLevel,
    ftyp: single(topLevel, 'ftyp'),
    movie,
    kept,
    dropped,
    mediaData,
    unreferencedBytes: mediaBytes - keptBytes + trailingBytes
  };
}
