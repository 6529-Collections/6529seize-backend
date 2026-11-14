import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import {
  androidVideo,
  audioTrack,
  box,
  buildVideo,
  goProVideo,
  IDENTIFYING_STRINGS,
  iphoneVideo,
  noise,
  telemetryTrack,
  timecodeTrack,
  TrackSpec,
  VideoSpec,
  videoTrack
} from './fixtures/synthetic-video-fixtures';
import { Box, readBoxes, VideoStructureProblem } from './iso-boxes';
import { stripVideoMetadataVerified } from './verified-video-strip';
import { VideoMetadataFinding } from './video-metadata-policy';
import { stripVideoMetadataFile } from './video-metadata-strip';

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'video-strip-test-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function strip(input: Buffer, name = 'input') {
  const inputPath = join(directory, name);
  const outputPath = join(directory, `${name}.stripped`);
  await writeFile(inputPath, input);
  const result = await stripVideoMetadataVerified(inputPath, outputPath);
  const output = existsSync(outputPath) ? await readFile(outputPath) : null;
  return { result, output, inputPath, outputPath };
}

function expectNoIdentifyingStrings(bytes: Buffer): void {
  const text = bytes.toString('latin1');
  for (const value of IDENTIFYING_STRINGS) expect(text).not.toContain(value);
  expect(text).not.toContain('©xyz');
}

function find(bytes: Buffer, path: string[], within?: Box): Box[] {
  const boxes = readBoxes(
    bytes,
    within ? within.payloadStart : 0,
    within ? within.end : bytes.length
  ).filter((candidate) => candidate.type === path[0]);
  if (path.length === 1) return boxes;
  return boxes.flatMap((parent) => find(bytes, path.slice(1), parent));
}

function topLevelTypes(bytes: Buffer): string[] {
  return readBoxes(bytes, 0, bytes.length).map((candidate) => candidate.type);
}

/** The display matrix of each track header (36 bytes after the times etc.). */
function matrices(bytes: Buffer): string[] {
  return find(bytes, ['moov', 'trak', 'tkhd']).map((tkhd) =>
    bytes
      .subarray(tkhd.payloadStart + 40, tkhd.payloadStart + 76)
      .toString('hex')
  );
}

/** SHA-256 of a fixture track's default sample bytes in decode order. */
function sampleHash(track: TrackSpec): string {
  const samples = track.sampleSizes.map((size, index) =>
    noise(`t${track.id}s${index}`, size)
  );
  return createHash('sha256').update(Buffer.concat(samples)).digest('hex');
}

describe('stripVideoMetadataVerified', () => {
  it('strips Apple location, date, make and model keys from an iPhone-style QuickTime file', async () => {
    const input = iphoneVideo();
    expect(input.toString('latin1')).toContain(
      'com.apple.quicktime.location.ISO6709'
    );

    const { result, output } = await strip(input);

    expect(result).toMatchObject({
      kind: 'stripped',
      removedTracks: [],
      findings: expect.arrayContaining([
        VideoMetadataFinding.LOCATION,
        VideoMetadataFinding.CAPTURE_TIME,
        VideoMetadataFinding.DEVICE
      ])
    });
    expectNoIdentifyingStrings(output!);
    expect(topLevelTypes(output!)).toEqual(['ftyp', 'moov', 'mdat']);
    // Rotation (the 90 degree display matrix) and codecs are unchanged.
    expect(matrices(output!)).toEqual(matrices(input));
    expect(
      find(output!, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
    ).toHaveLength(2);
    expect(output!.toString('latin1')).toContain('hvc1');
    expect(output!.toString('latin1')).toContain('colr');
  });

  it('strips Android ©xyz location from a fast-start MP4', async () => {
    const input = androidVideo();
    const { result, output } = await strip(input);
    expect(result).toMatchObject({
      kind: 'stripped',
      findings: expect.arrayContaining([VideoMetadataFinding.LOCATION])
    });
    expectNoIdentifyingStrings(output!);
    expect(find(output!, ['moov', 'udta'])).toHaveLength(0);
    const [ftypIn] = find(input, ['ftyp']);
    const [ftypOut] = find(output!, ['ftyp']);
    expect(output!.subarray(ftypOut.start, ftypOut.end)).toEqual(
      input.subarray(ftypIn.start, ftypIn.end)
    );
  });

  it('drops GoPro telemetry and timecode tracks with their samples, serials and XMP', async () => {
    const input = goProVideo();
    expect(input.toString('latin1')).toContain('GPS5');

    const { result, output } = await strip(input);

    expect(result).toMatchObject({
      kind: 'stripped',
      removedTracks: ['meta', 'tmcd'],
      findings: expect.arrayContaining([
        VideoMetadataFinding.TELEMETRY_TRACK,
        VideoMetadataFinding.OTHER_TRACK,
        VideoMetadataFinding.LOCATION,
        VideoMetadataFinding.USER_DATA
      ])
    });
    expectNoIdentifyingStrings(output!);
    expect(find(output!, ['moov', 'trak'])).toHaveLength(2);
    // The video track referred to the removed timecode track.
    expect(find(output!, ['moov', 'trak', 'tref'])).toHaveLength(0);
    const [mdat] = find(output!, ['mdat']);
    const avBytes = [videoTrack(), audioTrack()]
      .flatMap((track) => track.sampleSizes)
      .reduce((total, size) => total + size, 0);
    expect(mdat.end - mdat.payloadStart).toBe(avBytes);
  });

  it('keeps every audio and video sample byte for byte, in decode order', async () => {
    const spec: VideoSpec = {
      brand: 'isom',
      tracks: [videoTrack(), audioTrack(), telemetryTrack()],
      movieExtras: [box('udta', box('©xyz', Buffer.from('+37.4219-122.0840/')))]
    };
    const { result } = await strip(buildVideo(spec));
    expect(result.kind).toBe('stripped');
    if (result.kind !== 'stripped') return;
    const expected = [videoTrack(), audioTrack()].map(sampleHash);
    expect(result.tracks.map((track) => track.sha256)).toEqual(expected);
    expect(result.tracks.map((track) => track.codecs)).toEqual([
      ['avc1'],
      ['mp4a']
    ]);
  });

  it('keeps 64-bit chunk offsets', async () => {
    const { result, output } = await strip(
      androidVideo({ co64: true, moovFirst: false })
    );
    expect(result.kind).toBe('stripped');
    expect(
      find(output!, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'co64'])
    ).toHaveLength(2);
  });

  it('leaves a file without identifying data alone and writes nothing', async () => {
    const input = buildVideo({
      brand: 'isom',
      creationTime: 0,
      moovFirst: true,
      tracks: [videoTrack({ handlerName: '' }), audioTrack({ handlerName: '' })]
    });
    const { result, output } = await strip(input);
    expect(result).toEqual({ kind: 'clean', size: input.length });
    expect(output).toBeNull();
  });

  it('finds nothing left to strip in its own output', async () => {
    const first = await strip(goProVideo(), 'first');
    const second = await strip(first.output!, 'second');
    expect(second.result).toEqual({
      kind: 'clean',
      size: first.output!.length
    });
  });

  it('drops media data that no audio or video sample uses', async () => {
    const leftover = Buffer.concat([
      Buffer.from('DEVCGPS5'),
      noise('leftover', 200)
    ]);
    const input = buildVideo({
      brand: 'isom',
      creationTime: 0,
      tracks: [
        videoTrack({ handlerName: '' }),
        audioTrack({ handlerName: '' })
      ],
      unreferenced: leftover
    });
    const { result, output } = await strip(input);
    expect(result).toMatchObject({
      kind: 'stripped',
      findings: [VideoMetadataFinding.UNREFERENCED_DATA]
    });
    expect(output!.includes(leftover)).toBe(false);
  });

  it('drops old atoms an editor left behind as padding, but not zero padding', async () => {
    const cleanSpec: VideoSpec = {
      brand: 'isom',
      creationTime: 0,
      moovFirst: true,
      tracks: [videoTrack({ handlerName: '' }), audioTrack({ handlerName: '' })]
    };
    const leftover = box('©xyz', Buffer.from('+37.4219-122.0840/'));
    const padded = await strip(
      buildVideo({ ...cleanSpec, topLevelExtras: [box('free', leftover)] }),
      'padded'
    );
    expect(padded.result).toMatchObject({
      kind: 'stripped',
      findings: [VideoMetadataFinding.LOCATION]
    });
    expectNoIdentifyingStrings(padded.output!);

    const zeros = buildVideo({
      ...cleanSpec,
      topLevelExtras: [box('free', Buffer.alloc(64)), box('skip')]
    });
    const zeroPadded = await strip(zeros, 'zeros');
    expect(zeroPadded.result).toEqual({ kind: 'clean', size: zeros.length });
  });

  it('finds samples behind thousands of empty media data boxes', async () => {
    // Thousands of empty mdat boxes before the real one.
    const empty = Buffer.alloc(4000 * 8);
    for (let at = 0; at < empty.length; at += 8) {
      empty.writeUInt32BE(8, at);
      empty.write('mdat', at + 4, 'latin1');
    }
    const shifted = buildVideo({
      brand: 'mp42',
      moovFirst: true,
      tracks: [videoTrack({ handlerName: '' }), audioTrack({ handlerName: '' })]
    });
    const [moov] = find(shifted, ['moov']);
    const [shiftedMdat] = find(shifted, ['mdat']);
    // Chunk offsets point past the empty boxes once they are inserted.
    const withEmpty = Buffer.concat([
      shifted.subarray(0, shiftedMdat.start),
      empty,
      shifted.subarray(shiftedMdat.start)
    ]);
    const moovBytes = withEmpty.subarray(moov.start, moov.end);
    for (const stco of find(moovBytes, [
      'moov',
      'trak',
      'mdia',
      'minf',
      'stbl',
      'stco'
    ])) {
      const count = moovBytes.readUInt32BE(stco.payloadStart + 4);
      for (let index = 0; index < count; index++) {
        const at = stco.payloadStart + 8 + index * 4;
        moovBytes.writeUInt32BE(moovBytes.readUInt32BE(at) + empty.length, at);
      }
    }
    const { result } = await strip(withEmpty, 'many-mdat');
    expect(result).toMatchObject({
      kind: 'stripped',
      findings: [VideoMetadataFinding.CAPTURE_TIME]
    });
  });

  it('drops vendor data appended after the last box', async () => {
    const trailer = Buffer.concat([Buffer.from('SEFH'), noise('trailer', 99)]);
    const input = Buffer.concat([androidVideo(), trailer]);
    const { result, output } = await strip(input);
    expect(result).toMatchObject({
      kind: 'stripped',
      findings: expect.arrayContaining([VideoMetadataFinding.UNREFERENCED_DATA])
    });
    expect(output!.includes(trailer)).toBe(false);
  });

  it('handles classic QuickTime files without ftyp and constant sample sizes', async () => {
    const input = buildVideo({
      brand: null,
      quickTimeHandlers: true,
      tracks: [
        videoTrack(),
        audioTrack({
          sampleSizes: [512, 512, 512, 512, 512],
          constantSampleSize: true
        })
      ]
    });
    const { result, output } = await strip(input);
    expect(result.kind).toBe('stripped');
    expect(topLevelTypes(output!)).toEqual(['moov', 'mdat']);
  });

  it.each([
    [
      'a fragmented MP4',
      Buffer.concat([
        androidVideo(),
        box('moof', box('mfhd', Buffer.alloc(8)))
      ]),
      VideoStructureProblem.FRAGMENTED
    ],
    [
      'a WebM file',
      Buffer.concat([
        Buffer.from('1a45dfa3a3428286810142f7810142f2', 'hex'),
        Buffer.alloc(64)
      ]),
      VideoStructureProblem.NOT_ISO_MEDIA
    ],
    [
      'QuickTime sound counted in 1-byte samples',
      buildVideo({
        brand: 'qt  ',
        tracks: [
          videoTrack(),
          audioTrack({ sampleSizes: [1, 1, 1, 1], constantSampleSize: true })
        ]
      }),
      VideoStructureProblem.UNSUPPORTED_SAMPLE_TABLE
    ],
    [
      'a file with only telemetry',
      buildVideo({
        brand: 'isom',
        tracks: [telemetryTrack(), timecodeTrack()]
      }),
      VideoStructureProblem.NO_AUDIO_VIDEO_TRACKS
    ],
    [
      'a truncated file',
      iphoneVideo().subarray(0, 300),
      VideoStructureProblem.MALFORMED
    ],
    [
      'a sample description with an opaque vendor box',
      // The pixel-aspect box becomes a vendor `uuid` box inside avc1.
      Buffer.from(
        androidVideo().toString('latin1').replace('pasp', 'uuid'),
        'latin1'
      ),
      VideoStructureProblem.SAMPLE_DESCRIPTION_METADATA
    ]
  ])('refuses %s without writing anything', async (_, input, problem) => {
    const { result, output } = await strip(input);
    expect(result).toMatchObject({ kind: 'unsupported', problem });
    expect(output).toBeNull();
  });

  it('refuses tracks whose samples live in another file', async () => {
    const input = androidVideo();
    // Clear the self-contained flag of the first data reference.
    const marker = Buffer.from('url \0\0\0\x01', 'latin1');
    const at = input.indexOf(marker);
    input[at + 7] = 0;
    const { result } = await strip(input);
    expect(result).toMatchObject({
      kind: 'unsupported',
      problem: VideoStructureProblem.EXTERNAL_DATA_REFERENCE
    });
  });

  it('strips and verifies any layout of tracks, chunks and metadata', async () => {
    const sizes = fc.array(fc.integer({ min: 1, max: 900 }), {
      minLength: 1,
      maxLength: 24
    });
    await fc.assert(
      fc.asyncProperty(
        sizes,
        sizes,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (
          videoSizes,
          audioSizes,
          videoChunk,
          audioChunk,
          moovFirst,
          co64,
          telemetry
        ) => {
          const tracks: TrackSpec[] = [
            videoTrack({
              sampleSizes: videoSizes,
              samplesPerChunk: videoChunk
            }),
            audioTrack({
              sampleSizes: audioSizes,
              samplesPerChunk: audioChunk
            }),
            ...(telemetry ? [telemetryTrack()] : [])
          ];
          const input = buildVideo({ brand: 'mp42', tracks, moovFirst, co64 });
          const name = `p${Math.random().toString(36).slice(2)}`;
          const { result, output } = await strip(input, name);
          expect(result.kind).toBe('stripped');
          const [mdat] = find(output!, ['mdat']);
          const expected = [...videoSizes, ...audioSizes].reduce(
            (a, b) => a + b,
            0
          );
          expect(mdat.end - mdat.payloadStart).toBe(expected);
        }
      ),
      { numRuns: 30 }
    );
  });
});

describe('stripVideoMetadataFile', () => {
  it('reports which tracks it removed without verifying', async () => {
    const inputPath = join(directory, 'gopro');
    await writeFile(inputPath, goProVideo());
    const result = await stripVideoMetadataFile(
      inputPath,
      join(directory, 'out')
    );
    expect(result).toMatchObject({
      kind: 'stripped',
      removedTracks: ['meta', 'tmcd']
    });
  });
});
