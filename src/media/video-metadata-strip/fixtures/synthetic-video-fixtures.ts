import { createHash } from 'node:crypto';

/**
 * Builds small MP4 and QuickTime files box by box, with the metadata real
 * cameras and phones write: Apple `mdta` location and date keys, Android
 * `©xyz`, GoPro-style GPMF telemetry and timecode tracks, XMP, rotation
 * matrices and creation times. Sample bytes are deterministic noise; nothing
 * here decodes them.
 */

export const IDENTIFYING_STRINGS = [
  '+37.4219-122.0840',
  '+37.3349-122.0090',
  'com.apple.quicktime',
  'iPhone 15 Pro',
  'Pixel 8',
  'SERIAL-C3141592',
  'exif:GPSLatitude',
  '2024-05-01T10:00:00',
  'Core Media Video',
  'GoPro AVC',
  'DEVC',
  'GPS5'
] as const;

/** 2024-05-01T10:00:00Z in seconds since 1904 (MP4 epoch). */
export const CAPTURE_TIME = 3797407200;

export function box(type: string, ...parts: Buffer[]): Buffer {
  const header = Buffer.alloc(8);
  const size = 8 + parts.reduce((total, part) => total + part.length, 0);
  header.writeUInt32BE(size, 0);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, ...parts]);
}

function u32(...values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeInt32BE(value | 0, index * 4));
  return bytes;
}

function u16(...values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16BE(value, index * 2));
  return bytes;
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Buffer[]
) {
  return box(type, u32(version * 0x1000000 + flags), ...parts);
}

const latin1 = (text: string) => Buffer.from(text, 'latin1');

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const ROTATE_90 = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];

export type Codec = 'avc1' | 'hvc1' | 'mp4a' | 'gpmd' | 'tmcd' | 'tx3g';

export interface TrackSpec {
  readonly id: number;
  readonly handler: 'vide' | 'soun' | 'meta' | 'tmcd' | 'text';
  readonly codec: Codec;
  readonly sampleSizes: readonly number[];
  readonly samplesPerChunk: number;
  readonly rotate90?: boolean;
  readonly handlerName?: string;
  /** Payload of each sample; deterministic noise by default. */
  readonly sample?: (index: number) => Buffer;
  readonly trackUserData?: Buffer;
  readonly references?: { readonly type: string; readonly ids: number[] };
  /** Constant size in stsz instead of a table (all sampleSizes equal). */
  readonly constantSampleSize?: boolean;
}

export interface VideoSpec {
  /** Major brand, or null for a classic QuickTime file without `ftyp`. */
  readonly brand: string | null;
  readonly tracks: readonly TrackSpec[];
  readonly moovFirst?: boolean;
  readonly co64?: boolean;
  readonly creationTime?: number;
  /** Extra `moov` children (`udta`, `meta`, ...). */
  readonly movieExtras?: readonly Buffer[];
  /** Extra top-level boxes after the media (XMP `uuid`, ...). */
  readonly topLevelExtras?: readonly Buffer[];
  /** Bytes in `mdat` that no track uses. */
  readonly unreferenced?: Buffer;
  /** QuickTime handler layout (`mhlr`/`dhlr`, counted names, `alis`). */
  readonly quickTimeHandlers?: boolean;
}

export function noise(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block: Buffer = Buffer.alloc(0);
  for (let offset = 0; offset < length; offset += 32) {
    block = createHash('sha256')
      .update(seed)
      .update(block)
      .update(String(offset))
      .digest();
    block.copy(out, offset, 0, Math.min(32, length - offset));
  }
  return out;
}

function sampleBytes(track: TrackSpec, index: number): Buffer {
  const custom = track.sample?.(index);
  const size = track.sampleSizes[index];
  if (custom)
    return Buffer.concat([custom, noise(`p${track.id}`, size)]).subarray(
      0,
      size
    );
  return noise(`t${track.id}s${index}`, size);
}

function visualEntry(codec: 'avc1' | 'hvc1', compressor: string): Buffer {
  const name = Buffer.alloc(32);
  name[0] = compressor.length;
  name.write(compressor, 1, 'latin1');
  const fixed = Buffer.concat([
    Buffer.alloc(6),
    u16(1),
    Buffer.alloc(16),
    u16(320, 240),
    u32(0x480000, 0x480000, 0),
    u16(1),
    name,
    u16(0x18, 0xffff)
  ]);
  const config =
    codec === 'avc1'
      ? box('avcC', Buffer.from('0164001fffe100046764001f01000268ee', 'hex'))
      : box(
          'hvcC',
          Buffer.concat([Buffer.from([1, 1, 0x60, 0, 0, 0]), Buffer.alloc(17)])
        );
  const colr = box('colr', latin1('nclx'), u16(9, 18, 9), Buffer.from([0x80]));
  return box(codec, fixed, config, colr, box('pasp', u32(1, 1)));
}

function sampleEntry(codec: Codec): Buffer {
  const head = Buffer.concat([Buffer.alloc(6), u16(1)]);
  switch (codec) {
    case 'avc1':
      return visualEntry('avc1', 'H.264');
    case 'hvc1':
      return visualEntry('hvc1', 'HEVC');
    case 'mp4a':
      return box(
        'mp4a',
        head,
        Buffer.alloc(8),
        u16(2, 16, 0, 0),
        u32(44100 * 0x10000),
        fullBox(
          'esds',
          0,
          0,
          Buffer.from(
            '03190000000411401500000000000000000000000502121006010102',
            'hex'
          )
        )
      );
    case 'gpmd':
      return box('gpmd', head);
    case 'tmcd':
      return box('tmcd', head, u32(0, 0, 30000, 1001), Buffer.from([30, 0]));
    case 'tx3g':
      return box('tx3g', head, Buffer.alloc(30));
  }
}

function mediaHeader(handler: TrackSpec['handler']): Buffer {
  if (handler === 'vide') return fullBox('vmhd', 0, 1, Buffer.alloc(8));
  if (handler === 'soun') return fullBox('smhd', 0, 0, Buffer.alloc(4));
  return fullBox('nmhd', 0, 0);
}

function handlerBox(
  componentType: string,
  handler: string,
  name: string,
  quickTime: boolean
): Buffer {
  const nameBytes = quickTime
    ? Buffer.concat([Buffer.from([name.length]), latin1(name)])
    : Buffer.concat([latin1(name), Buffer.alloc(1)]);
  return fullBox(
    'hdlr',
    0,
    0,
    quickTime ? latin1(componentType) : Buffer.alloc(4),
    latin1(handler),
    quickTime ? latin1('appl') : Buffer.alloc(4),
    Buffer.alloc(8),
    nameBytes
  );
}

function sampleToChunk(total: number, perChunk: number): Buffer {
  const chunks = Math.ceil(total / perChunk);
  const last = total - (chunks - 1) * perChunk;
  const runs =
    last === perChunk || chunks === 1
      ? [[1, chunks === 1 ? last : perChunk, 1]]
      : [
          [1, perChunk, 1],
          [chunks, last, 1]
        ];
  return fullBox(
    'stsc',
    0,
    0,
    u32(runs.length),
    ...runs.map((run) => u32(...run))
  );
}

function sampleTable(
  track: TrackSpec,
  offsets: number[],
  co64: boolean
): Buffer {
  const count = track.sampleSizes.length;
  const constant = track.constantSampleSize ? track.sampleSizes[0] : 0;
  const stsz = fullBox(
    'stsz',
    0,
    0,
    u32(constant, count),
    ...(constant ? [] : [u32(...track.sampleSizes)])
  );
  const chunkOffsets = co64
    ? fullBox(
        'co64',
        0,
        0,
        u32(offsets.length),
        ...offsets.map((offset) =>
          u32(Math.floor(offset / 0x100000000), offset % 0x100000000)
        )
      )
    : fullBox('stco', 0, 0, u32(offsets.length), u32(...offsets));
  return box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), sampleEntry(track.codec)),
    fullBox('stts', 0, 0, u32(1, count, 1000)),
    ...(track.handler === 'vide' ? [fullBox('stss', 0, 0, u32(1, 1))] : []),
    sampleToChunk(count, track.samplesPerChunk),
    stsz,
    chunkOffsets
  );
}

function trackBox(
  spec: VideoSpec,
  track: TrackSpec,
  offsets: number[]
): Buffer {
  const time = spec.creationTime ?? CAPTURE_TIME;
  const duration = track.sampleSizes.length * 1000;
  const visual = track.handler === 'vide';
  const tkhd = fullBox(
    'tkhd',
    0,
    3,
    u32(time, time, track.id, 0, duration, 0, 0),
    u16(0, 0, track.handler === 'soun' ? 0x100 : 0, 0),
    u32(...(track.rotate90 ? ROTATE_90 : IDENTITY)),
    u32(visual ? 320 * 0x10000 : 0, visual ? 240 * 0x10000 : 0)
  );
  const quickTime = spec.quickTimeHandlers === true;
  const name = track.handlerName ?? '';
  const dref = fullBox(
    'dref',
    0,
    0,
    u32(1),
    fullBox(quickTime ? 'alis' : 'url ', 0, 1)
  );
  const minf = box(
    'minf',
    mediaHeader(track.handler),
    ...(quickTime ? [handlerBox('dhlr', 'alis', name, true)] : []),
    box('dinf', dref),
    sampleTable(track, offsets, spec.co64 === true)
  );
  const mdia = box(
    'mdia',
    fullBox('mdhd', 0, 0, u32(time, time, 1000, duration), u16(0x55c4, 0)),
    handlerBox('mhlr', track.handler, name, quickTime),
    minf
  );
  const edts = box('edts', fullBox('elst', 0, 0, u32(1, duration, 0, 0x10000)));
  const tref = track.references
    ? [box('tref', box(track.references.type, u32(...track.references.ids)))]
    : [];
  return box(
    'trak',
    tkhd,
    edts,
    ...tref,
    mdia,
    ...(track.trackUserData ? [track.trackUserData] : [])
  );
}

function movieBox(spec: VideoSpec, offsets: number[][]): Buffer {
  const time = spec.creationTime ?? CAPTURE_TIME;
  const duration =
    Math.max(...spec.tracks.map((track) => track.sampleSizes.length)) * 1000;
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(time, time, 1000, duration, 0x10000),
    u16(0x100),
    Buffer.alloc(10),
    u32(...IDENTITY),
    Buffer.alloc(24),
    u32(spec.tracks.length + 1)
  );
  return box(
    'moov',
    mvhd,
    ...spec.tracks.map((track, index) => trackBox(spec, track, offsets[index])),
    ...(spec.movieExtras ?? [])
  );
}

interface Layout {
  readonly payload: Buffer;
  /** Offsets of each track's chunks relative to the mdat payload. */
  readonly relative: number[][];
}

/** Chunks interleaved round-robin across tracks, as cameras write them. */
function mediaLayout(spec: VideoSpec): Layout {
  const chunks = spec.tracks.map((track) => {
    const list: Buffer[] = [];
    for (
      let start = 0;
      start < track.sampleSizes.length;
      start += track.samplesPerChunk
    ) {
      const end = Math.min(
        track.sampleSizes.length,
        start + track.samplesPerChunk
      );
      const samples: Buffer[] = [];
      for (let index = start; index < end; index++)
        samples.push(sampleBytes(track, index));
      list.push(Buffer.concat(samples));
    }
    return list;
  });
  const parts: Buffer[] = [];
  const relative = spec.tracks.map(() => [] as number[]);
  let position = 0;
  const rounds = Math.max(...chunks.map((list) => list.length));
  for (let round = 0; round < rounds; round++) {
    chunks.forEach((list, track) => {
      const chunk = list[round];
      if (!chunk) return;
      relative[track].push(position);
      parts.push(chunk);
      position += chunk.length;
    });
    if (round === 0 && spec.unreferenced) {
      parts.push(spec.unreferenced);
      position += spec.unreferenced.length;
    }
  }
  return { payload: Buffer.concat(parts), relative };
}

export function buildVideo(spec: VideoSpec): Buffer {
  const ftyp = spec.brand
    ? box(
        'ftyp',
        latin1(spec.brand),
        u32(0x200),
        latin1(spec.brand),
        latin1('isom')
      )
    : Buffer.alloc(0);
  const media = mediaLayout(spec);
  const mdat = box('mdat', media.payload);
  const absolute = (base: number) =>
    media.relative.map((offsets) => offsets.map((offset) => base + offset));
  const extras = spec.topLevelExtras ?? [];
  if (spec.moovFirst) {
    const draft = movieBox(spec, absolute(0));
    const moov = movieBox(spec, absolute(ftyp.length + draft.length + 8));
    return Buffer.concat([ftyp, moov, mdat, ...extras]);
  }
  const moov = movieBox(spec, absolute(ftyp.length + 8));
  return Buffer.concat([ftyp, mdat, moov, ...extras]);
}

/** Android: `udta/©xyz` (ISO 6709 text) and make/model. */
export function androidUserData(): Buffer {
  const text = (value: string) =>
    Buffer.concat([u16(value.length, 0x15c7), latin1(value)]);
  return box(
    'udta',
    box('©xyz', text('+37.4219-122.0840/')),
    box('©mod', text('Pixel 8'))
  );
}

/** Apple: `moov/meta` with `mdta` keys for location, date, make and model. */
export function appleMetadata(): Buffer {
  const entries: Array<[string, string]> = [
    ['com.apple.quicktime.location.ISO6709', '+37.3349-122.0090+010.000/'],
    ['com.apple.quicktime.creationdate', '2024-05-01T10:00:00-0700'],
    ['com.apple.quicktime.make', 'Apple'],
    ['com.apple.quicktime.model', 'iPhone 15 Pro']
  ];
  const keys = fullBox(
    'keys',
    0,
    0,
    u32(entries.length),
    ...entries.map(([key]) =>
      Buffer.concat([u32(key.length + 8), latin1('mdta'), latin1(key)])
    )
  );
  const items = entries.map(([, value], index) => {
    const data = box('data', u32(1, 0), latin1(value));
    const item = Buffer.concat([u32(8 + data.length, index + 1), data]);
    return item;
  });
  return box(
    'meta',
    fullBox(
      'hdlr',
      0,
      0,
      Buffer.alloc(4),
      latin1('mdta'),
      Buffer.alloc(12),
      Buffer.alloc(1)
    ),
    keys,
    box('ilst', ...items)
  );
}

/** GoPro-style `udta`: firmware, camera serial and a GPMF settings box. */
export function goProUserData(): Buffer {
  return box(
    'udta',
    box('FIRM', latin1('HD9.01.01.60.00')),
    box('CAME', latin1('SERIAL-C3141592')),
    box('GPMF', latin1('DEVC'), noise('gpmf', 24))
  );
}

/** An XMP packet in the standard XMP `uuid` box. */
export function xmpUuid(): Buffer {
  return box(
    'uuid',
    Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex'),
    latin1(
      '<x:xmpmeta><rdf:Description exif:GPSLatitude="37,25.3N"/></x:xmpmeta>'
    )
  );
}

/** A GPMF-like sample: `DEVC` and `GPS5` KLV headers with fix data. */
export function gpmfSample(): Buffer {
  return Buffer.concat([
    latin1('DEVC'),
    u32(0x0100),
    latin1('GPS5'),
    u32(0x6c140001)
  ]);
}

export function videoTrack(overrides: Partial<TrackSpec> = {}): TrackSpec {
  return {
    id: 1,
    handler: 'vide',
    codec: 'avc1',
    sampleSizes: [1800, 420, 380, 410, 1750, 400, 390, 405],
    samplesPerChunk: 2,
    handlerName: 'Core Media Video',
    ...overrides
  };
}

export function audioTrack(overrides: Partial<TrackSpec> = {}): TrackSpec {
  return {
    id: 2,
    handler: 'soun',
    codec: 'mp4a',
    sampleSizes: [371, 372, 370, 368, 369, 371, 373, 366, 370, 372],
    samplesPerChunk: 3,
    handlerName: 'Core Media Audio',
    ...overrides
  };
}

export function telemetryTrack(overrides: Partial<TrackSpec> = {}): TrackSpec {
  return {
    id: 3,
    handler: 'meta',
    codec: 'gpmd',
    sampleSizes: [96, 96, 96, 96],
    samplesPerChunk: 1,
    handlerName: 'GoPro MET',
    sample: () => gpmfSample(),
    ...overrides
  };
}

export function timecodeTrack(overrides: Partial<TrackSpec> = {}): TrackSpec {
  return {
    id: 4,
    handler: 'tmcd',
    codec: 'tmcd',
    sampleSizes: [4],
    samplesPerChunk: 1,
    handlerName: 'GoPro TCD',
    ...overrides
  };
}

/** An iPhone-like QuickTime file: HEVC, AAC, Apple keys, rotation. */
export function iphoneVideo(overrides: Partial<VideoSpec> = {}): Buffer {
  return buildVideo({
    brand: 'qt  ',
    quickTimeHandlers: true,
    tracks: [videoTrack({ codec: 'hvc1', rotate90: true }), audioTrack()],
    movieExtras: [appleMetadata()],
    ...overrides
  });
}

/** An Android-like MP4: H.264, AAC, `©xyz`. */
export function androidVideo(overrides: Partial<VideoSpec> = {}): Buffer {
  return buildVideo({
    brand: 'mp42',
    moovFirst: true,
    tracks: [
      videoTrack({ handlerName: 'VideoHandle' }),
      audioTrack({ handlerName: 'SoundHandle' })
    ],
    movieExtras: [androidUserData()],
    ...overrides
  });
}

/** A GoPro-like MP4: H.264, AAC, GPMF telemetry, timecode, serial, XMP. */
export function goProVideo(overrides: Partial<VideoSpec> = {}): Buffer {
  return buildVideo({
    brand: 'mp41',
    tracks: [
      videoTrack({
        handlerName: 'GoPro AVC',
        references: { type: 'tmcd', ids: [4] }
      }),
      audioTrack({ handlerName: 'GoPro AAC' }),
      telemetryTrack(),
      timecodeTrack()
    ],
    movieExtras: [goProUserData()],
    topLevelExtras: [xmpUuid()],
    ...overrides
  });
}
