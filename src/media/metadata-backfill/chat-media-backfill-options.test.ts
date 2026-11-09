import { ChatMediaSource } from './chat-media-candidates';
import {
  parseBackfillArgs,
  parseDuration
} from './chat-media-backfill.options';

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
      probeVideos: true
    });
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

describe('parseDuration', () => {
  it('reads days and hours', () => {
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('168h')).toBe(604_800_000);
    expect(() => parseDuration('1w')).toThrow('Invalid duration');
  });
});
