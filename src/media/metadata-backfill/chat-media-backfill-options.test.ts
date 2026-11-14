import { ChatMediaSource } from './chat-media-candidates';
import {
  parseBackfillArgs,
  parseByteSize,
  parseDuration
} from './chat-media-backfill.options';
import { ObjectSkipReason } from './chat-media-object-processor';

const RUN_ID = '20261116T120000Z-0a1b2c3d';

describe('parseBackfillArgs', () => {
  it('scan defaults to a dry run with video probing', () => {
    expect(parseBackfillArgs(['scan', '--environment', 'prod'])).toEqual({
      command: 'scan',
      environment: 'prod',
      execute: false,
      runId: null,
      reportPath: null,
      limit: null,
      sample: null,
      concurrency: 2,
      pageSize: 500,
      resumeAfter: null,
      probeVideos: true,
      maxSourceBytes: 256 * 1024 * 1024,
      keysFromReport: null,
      skipReasons: null,
      includeVideos: false,
      maxVideoBytes: 500 * 1024 * 1024
    });
  });

  it('rewrites chat videos only when asked to, up to the video limit', () => {
    expect(
      parseBackfillArgs([
        'scan',
        '--environment',
        'prod',
        '--include-videos',
        '--max-video-bytes',
        '200MiB'
      ])
    ).toMatchObject({ includeVideos: true, maxVideoBytes: 200 * 1024 * 1024 });
    expect(() =>
      parseBackfillArgs([
        'scan',
        '--environment',
        'prod',
        '--max-video-bytes',
        '200MiB'
      ])
    ).toThrow('--max-video-bytes needs --include-videos');
    expect(() =>
      parseBackfillArgs([
        'scan',
        '--environment',
        'prod',
        '--include-videos',
        '--max-video-bytes',
        '2GiB'
      ])
    ).toThrow('--max-video-bytes must be between 1MiB and 1GiB');
    expect(() =>
      parseBackfillArgs([
        'restore',
        '--environment',
        'prod',
        '--run-id',
        RUN_ID,
        '--max-video-bytes',
        '200MiB'
      ])
    ).toThrow('--max-video-bytes does not apply to restore');
  });

  it('reads the source limit and a report of keys to retry', () => {
    expect(
      parseBackfillArgs([
        'scan',
        '--environment',
        'prod',
        '--max-source-bytes',
        '512MiB',
        '--keys-from-report',
        'scan-dry-run.json'
      ])
    ).toMatchObject({
      maxSourceBytes: 512 * 1024 * 1024,
      keysFromReport: 'scan-dry-run.json',
      skipReasons: [
        ObjectSkipReason.VERIFICATION_FAILED,
        ObjectSkipReason.TOO_LARGE,
        ObjectSkipReason.UNPARSEABLE_CONTAINER
      ]
    });
    expect(
      parseBackfillArgs([
        'scan',
        '--environment',
        'prod',
        '--keys-from-report=scan.json',
        '--skip-reasons',
        'too_large'
      ])
    ).toMatchObject({ skipReasons: [ObjectSkipReason.TOO_LARGE] });
  });

  it('reads every scan option in both flag forms', () => {
    expect(
      parseBackfillArgs([
        'scan',
        '--environment=staging',
        '--execute',
        '--limit',
        '25',
        '--concurrency=4',
        '--page-size',
        '100',
        '--resume-after',
        'wave_picture:42',
        '--run-id',
        RUN_ID,
        '--report=out.json'
      ])
    ).toMatchObject({
      environment: 'staging',
      execute: true,
      limit: 25,
      concurrency: 4,
      pageSize: 100,
      resumeAfter: { phase: ChatMediaSource.WAVE_PICTURE, after: 42 },
      runId: RUN_ID,
      reportPath: 'out.json',
      probeVideos: false
    });
  });

  it.each([
    [['scan'], '--environment'],
    [['scan', '--environment', 'dev'], '--environment'],
    [['scan', '--environment', 'prod', '--dry-run', '--execute'], 'not both'],
    [['scan', '--environment', 'prod', '--limit', '0'], '--limit'],
    [['scan', '--environment', 'prod', '--concurrency', '9'], '--concurrency'],
    [
      ['scan', '--environment', 'prod', '--limit', '1', '--sample', '1'],
      'cannot be combined'
    ],
    [
      [
        'scan',
        '--environment',
        'prod',
        '--sample',
        '1',
        '--resume-after',
        'drop_media:1'
      ],
      'cannot resume'
    ],
    [
      ['scan', '--environment', 'prod', '--resume-after', 'drops:1'],
      'Invalid cursor'
    ],
    [['scan', '--environment', 'prod', '--run-id', 'latest'], 'Invalid run id'],
    [
      ['scan', '--environment', 'prod', '--max-source-bytes', '2GiB'],
      'between 1MiB and 1GiB'
    ],
    [
      ['scan', '--environment', 'prod', '--max-source-bytes', '10MB'],
      'Invalid size'
    ],
    [
      ['scan', '--environment', 'prod', '--skip-reasons', 'too_large'],
      'needs --keys-from-report'
    ],
    [
      [
        'scan',
        '--environment',
        'prod',
        '--keys-from-report',
        'r.json',
        '--skip-reasons',
        'too_big'
      ],
      'Unknown skip reason'
    ],
    [
      [
        'scan',
        '--environment',
        'prod',
        '--keys-from-report',
        'r.json',
        '--sample',
        '5'
      ],
      '--sample'
    ],
    [
      [
        'restore',
        '--environment',
        'prod',
        '--run-id',
        RUN_ID,
        '--keys-from-report',
        'r.json'
      ],
      'does not apply'
    ],
    [['scan', '--environment', 'prod', '--live'], 'Unknown argument'],
    [['scan', '--environment'], 'needs a value'],
    [['restore', '--environment', 'prod'], '--run-id is required'],
    [
      ['restore', '--environment', 'prod', '--run-id', RUN_ID, '--limit', '1'],
      'does not apply'
    ],
    [
      ['purge-originals', '--environment', 'prod', '--run-id', RUN_ID],
      '--older-than is required'
    ],
    [['backfill'], 'Unknown command']
  ])('rejects %j', (args, message) => {
    expect(() => parseBackfillArgs(args)).toThrow(message);
  });

  it('parses restore, invalidate and purge', () => {
    expect(
      parseBackfillArgs([
        'restore',
        '--environment',
        'prod',
        '--run-id',
        RUN_ID,
        '--key',
        'drops/a/b.jpg',
        '--execute'
      ])
    ).toMatchObject({
      command: 'restore',
      key: 'drops/a/b.jpg',
      execute: true
    });
    expect(
      parseBackfillArgs([
        'invalidate',
        '--environment',
        'prod',
        '--run-id',
        RUN_ID
      ])
    ).toMatchObject({ command: 'invalidate', execute: false });
    expect(
      parseBackfillArgs([
        'purge-originals',
        '--environment',
        'prod',
        '--run-id',
        RUN_ID,
        '--older-than',
        '7d',
        '--delete-noncurrent-public-versions'
      ])
    ).toMatchObject({
      command: 'purge-originals',
      olderThanMillis: 7 * 24 * 3600 * 1000,
      deleteNoncurrentPublicVersions: true,
      execute: false
    });
  });
});

describe('parseByteSize', () => {
  it('reads bytes with an optional binary unit', () => {
    expect(parseByteSize('268435456')).toBe(268_435_456);
    expect(parseByteSize('256MiB')).toBe(268_435_456);
    expect(parseByteSize('1 gib')).toBe(1024 ** 3);
    expect(parseByteSize('64KiB')).toBe(65_536);
    expect(() => parseByteSize('1.5GiB')).toThrow('Invalid size');
  });
});

describe('parseDuration', () => {
  it('reads days and hours', () => {
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('168h')).toBe(604_800_000);
    expect(() => parseDuration('1w')).toThrow('Invalid duration');
  });
});
