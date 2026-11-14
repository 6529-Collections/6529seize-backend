import {
  Box,
  childBoxes,
  payloadOf,
  readBoxes,
  timeFieldsEnd
} from './iso-boxes';
import { readDataReferences, sampleEntryTypes } from './movie-structure';
import { VideoLayout } from './video-layout';

/**
 * What a stripped movie header may contain, by parent box. Everything else
 * (`udta`, `meta`, `uuid`, `iods`, timed-metadata tracks, chapter lists, ...)
 * is removed. Leaves are kept as they are, except the times and handler
 * names this module checks.
 */
export const KEPT_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  moov: new Set(['mvhd', 'trak']),
  trak: new Set(['tkhd', 'edts', 'tref', 'tapt', 'mdia']),
  edts: new Set(['elst']),
  mdia: new Set(['mdhd', 'hdlr', 'minf']),
  minf: new Set(['vmhd', 'smhd', 'hdlr', 'dinf', 'stbl']),
  dinf: new Set(['dref']),
  stbl: new Set([
    'stsd',
    'stts',
    'ctts',
    'cslg',
    'stss',
    'stps',
    'sdtp',
    'stsc',
    'stsz',
    'stco',
    'co64',
    'sgpd',
    'sbgp',
    'subs'
  ])
};

/** Top-level boxes the strip keeps or rebuilds. */
const MOVIE_BOXES = new Set(['ftyp', 'moov', 'mdat']);

/**
 * Padding boxes. Editors that rewrite a movie header in place leave the old
 * atoms (location included) behind as padding, so padding only counts as
 * harmless when it is empty or all zeros.
 */
const PADDING_BOXES = new Set(['free', 'skip', 'wide']);

/** Kinds of identifying data a video can carry; values are never recorded. */
export enum VideoMetadataFinding {
  /** `©xyz`, 3GPP `loci`, Apple ISO 6709 keys, XMP GPS fields. */
  LOCATION = 'location',
  /** Non-zero creation/modification times, `©day`, Apple creation dates. */
  CAPTURE_TIME = 'capture_time',
  /** Make, model and software, and track handler names. */
  DEVICE = 'device',
  /** Timed metadata tracks: GoPro GPMF, camera motion, Apple `mebx`. */
  TELEMETRY_TRACK = 'telemetry_track',
  /** Timecode, text, subtitle, chapter and other non-audio/video tracks. */
  OTHER_TRACK = 'other_track',
  /** Other user data, metadata or vendor boxes (XMP included). */
  USER_DATA = 'user_data',
  /** Media data no audio/video sample uses. */
  UNREFERENCED_DATA = 'unreferenced_data'
}

const TELEMETRY_HANDLERS = new Set(['meta', 'camm']);
const TELEMETRY_CODECS = new Set(['gpmd', 'camm', 'mebx']);

interface Marker {
  readonly bytes: Buffer;
  readonly finding: VideoMetadataFinding;
}

function markers(
  finding: VideoMetadataFinding,
  texts: readonly string[]
): Marker[] {
  return texts.map((text) => ({ bytes: Buffer.from(text, 'latin1'), finding }));
}

/** Names that tell which kind of data a removed metadata box holds. */
const MARKERS: readonly Marker[] = [
  ...markers(VideoMetadataFinding.LOCATION, [
    '©xyz',
    'loci',
    'ISO6709',
    'location',
    'GPSLatitude',
    'GPSCoordinates'
  ]),
  ...markers(VideoMetadataFinding.CAPTURE_TIME, [
    '©day',
    'creationdate',
    'CreateDate'
  ]),
  ...markers(VideoMetadataFinding.DEVICE, [
    '©mak',
    '©mod',
    '©swr',
    '.make',
    '.model',
    '.software'
  ])
];

/**
 * Long markers that must never appear anywhere in a stripped movie header,
 * sample descriptions included. Short ones could occur by chance in binary
 * tables, so they are only searched inside metadata boxes.
 */
const FORBIDDEN_HEADER_TEXT: readonly Buffer[] = [
  'ISO6709',
  'com.apple.quicktime',
  'GPSLatitude',
  'GPSCoordinates'
].map((text) => Buffer.from(text, 'latin1'));

/** Boxes that must not hide inside a kept sample description. */
const FORBIDDEN_IN_SAMPLE_DESCRIPTION: readonly Buffer[] = [
  'udta',
  'meta',
  'ilst',
  'keys',
  '©xyz'
].map((text) => Buffer.from(text, 'latin1'));

/** Findings in a box that is removed whole: marker hits, else `fallback`. */
function classifyRemovedBytes(
  bytes: Buffer,
  fallback = VideoMetadataFinding.USER_DATA
): VideoMetadataFinding[] {
  const hits = MARKERS.filter((marker) => bytes.includes(marker.bytes)).map(
    (marker) => marker.finding
  );
  return hits.length ? hits : [fallback];
}

/**
 * Findings for one top-level box; `bytes` holds the whole box when it was
 * small enough to read. Unread padding is assumed to hold old data.
 */
function topLevelFindings(
  box: Box,
  bytes: Buffer | undefined
): VideoMetadataFinding[] {
  if (MOVIE_BOXES.has(box.type)) return [];
  if (!PADDING_BOXES.has(box.type)) {
    return bytes
      ? classifyRemovedBytes(bytes)
      : [VideoMetadataFinding.USER_DATA];
  }
  if (box.payloadStart === box.end) return [];
  if (!bytes) return [VideoMetadataFinding.UNREFERENCED_DATA];
  const payload = bytes.subarray(box.payloadStart - box.start);
  if (payload.every((byte) => byte === 0)) return [];
  return classifyRemovedBytes(payload, VideoMetadataFinding.UNREFERENCED_DATA);
}

/** True when a box's version 0/1 creation and modification times are zero. */
export function hasZeroTimes(payload: Buffer, type: string): boolean {
  return payload
    .subarray(4, timeFieldsEnd(payload, type))
    .every((byte) => byte === 0);
}

/** True when an `hdlr` name is empty (one NUL, or nothing at all). */
export function hasEmptyHandlerName(payload: Buffer): boolean {
  return payload.length >= 24 && payload.subarray(24).every((b) => b === 0);
}

class Findings {
  readonly found = new Set<VideoMetadataFinding>();
  readonly problems: string[] = [];

  add(finding: VideoMetadataFinding, problem: string): void {
    this.found.add(finding);
    if (this.problems.length < 20) this.problems.push(problem);
  }
}

function checkTimes(moov: Buffer, box: Box, findings: Findings): void {
  if (!hasZeroTimes(payloadOf(moov, box), box.type)) {
    findings.add(VideoMetadataFinding.CAPTURE_TIME, `${box.type} has times`);
  }
}

function checkHandlerName(moov: Buffer, box: Box, findings: Findings): void {
  if (!hasEmptyHandlerName(payloadOf(moov, box))) {
    findings.add(VideoMetadataFinding.DEVICE, 'hdlr has a name');
  }
}

function checkSampleDescription(moov: Buffer, box: Box, findings: Findings) {
  const payload = payloadOf(moov, box);
  FORBIDDEN_IN_SAMPLE_DESCRIPTION.forEach((marker) => {
    if (payload.includes(marker)) {
      findings.add(VideoMetadataFinding.USER_DATA, 'stsd holds metadata');
    }
  });
}

function checkLeaf(moov: Buffer, box: Box, findings: Findings): void {
  switch (box.type) {
    case 'mvhd':
    case 'tkhd':
    case 'mdhd':
      checkTimes(moov, box, findings);
      break;
    case 'hdlr':
      checkHandlerName(moov, box, findings);
      break;
    case 'stsd':
      checkSampleDescription(moov, box, findings);
      break;
    case 'dref': {
      const refs = readDataReferences(moov, box);
      if (refs.external || refs.withData) {
        findings.add(VideoMetadataFinding.USER_DATA, 'dref names other data');
      }
      break;
    }
    case 'tref':
      if (childBoxes(moov, box).some((ref) => ref.type === 'chap')) {
        findings.add(VideoMetadataFinding.OTHER_TRACK, 'chapter reference');
      }
      break;
    default:
      break;
  }
}

/**
 * Walks the movie header against the kept-box policy. Tracks that are
 * removed whole are reported once, by kind, instead of box by box.
 */
function walk(
  moov: Buffer,
  parent: Box,
  findings: Findings,
  removedTracks: ReadonlySet<number>
): void {
  const allowed = KEPT_CHILDREN[parent.type];
  for (const child of childBoxes(moov, parent)) {
    if (removedTracks.has(child.start)) continue;
    if (!allowed.has(child.type)) {
      classifyRemovedBytes(moov.subarray(child.start, child.end)).forEach(
        (finding) =>
          findings.add(
            finding,
            `${parent.type} has ${JSON.stringify(child.type)}`
          )
      );
      continue;
    }
    if (KEPT_CHILDREN[child.type]) {
      walk(moov, child, findings, removedTracks);
    } else {
      checkLeaf(moov, child, findings);
    }
  }
}

function checkTracks(layout: VideoLayout, findings: Findings): void {
  const { moov } = layout.movie;
  for (const track of layout.dropped) {
    const telemetry =
      TELEMETRY_HANDLERS.has(track.handler) ||
      sampleEntryTypes(moov, track).some((type) => TELEMETRY_CODECS.has(type));
    findings.add(
      telemetry
        ? VideoMetadataFinding.TELEMETRY_TRACK
        : VideoMetadataFinding.OTHER_TRACK,
      `${JSON.stringify(track.handler)} track`
    );
  }
}

/**
 * Identifying data the file carries, judged against the strip policy: any
 * non-audio/video track, any box outside the kept set, non-zero times,
 * handler names, data references to other files, metadata inside sample
 * descriptions, unreferenced media data, and top-level boxes other than
 * `ftyp`, `moov`, `mdat` and padding. `topLevelBytes` gives the bytes of
 * small removed top-level boxes so their findings can be named.
 */
export function findIdentifyingMetadata(
  layout: VideoLayout,
  topLevelBytes: ReadonlyMap<number, Buffer> = new Map()
): { readonly findings: VideoMetadataFinding[]; readonly problems: string[] } {
  const findings = new Findings();
  for (const box of layout.topLevel) {
    topLevelFindings(box, topLevelBytes.get(box.start)).forEach((finding) =>
      findings.add(finding, `top-level ${JSON.stringify(box.type)}`)
    );
  }
  const { moov } = layout.movie;
  const [moovBox] = readBoxes(moov, 0, moov.length);
  const removedTracks = new Set(layout.dropped.map((track) => track.box.start));
  walk(moov, moovBox, findings, removedTracks);
  checkTracks(layout, findings);
  FORBIDDEN_HEADER_TEXT.forEach((marker) => {
    if (moov.includes(marker)) {
      findings.add(VideoMetadataFinding.LOCATION, 'location text in moov');
    }
  });
  if (layout.unreferencedBytes !== 0) {
    findings.add(
      VideoMetadataFinding.UNREFERENCED_DATA,
      `${layout.unreferencedBytes} unreferenced media bytes`
    );
  }
  const order = Object.values(VideoMetadataFinding);
  return {
    findings: Array.from(findings.found).sort(
      (a, b) => order.indexOf(a) - order.indexOf(b)
    ),
    problems: findings.problems
  };
}
