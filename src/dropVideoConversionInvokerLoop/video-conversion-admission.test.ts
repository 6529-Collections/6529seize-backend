import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  admitVideoConversion,
  DEFAULT_VIDEO_CONVERSION_LIMITS,
  videoConversionLedgerKey,
  videoConversionLimitsFrom
} from './video-conversion-admission';

const BUCKET = 'bucket';
const KEY = 'drops/upload/upload.mp4';
const HOUR = 60 * 60 * 1000;
const NOW = 100 * HOUR;

function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status }
  });
}

/** An in-memory bucket with S3's conditional write semantics. */
function fakeS3({
  videoEtag = 'v1',
  videoSize = 1000,
  headError
}: { videoEtag?: string; videoSize?: number; headError?: Error } = {}) {
  const objects = new Map<string, { body: string; etag: string }>();
  let version = 0;
  const puts: PutObjectCommand['input'][] = [];
  let beforePut: (() => void) | undefined;
  const send = jest.fn(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      if (headError) throw headError;
      return { ETag: `"${videoEtag}"`, ContentLength: videoSize };
    }
    if (command instanceof GetObjectCommand) {
      const stored = objects.get(command.input.Key!);
      if (!stored) throw s3Error('NoSuchKey', 404);
      return {
        ETag: `"${stored.etag}"`,
        Body: { transformToString: async () => stored.body }
      };
    }
    if (command instanceof PutObjectCommand) {
      beforePut?.();
      beforePut = undefined;
      const input = command.input;
      const existing = objects.get(input.Key!);
      if (input.IfNoneMatch === '*' && existing)
        throw s3Error('PreconditionFailed', 412);
      if (input.IfMatch && input.IfMatch !== `"${existing?.etag}"`)
        throw s3Error('PreconditionFailed', 412);
      puts.push(input);
      objects.set(input.Key!, {
        body: String(input.Body),
        etag: `ledger-${++version}`
      });
      return {};
    }
    throw new Error('unexpected command');
  });
  return {
    s3: { send } as unknown as S3Client,
    send,
    puts,
    ledger: () => {
      const stored = objects.get(videoConversionLedgerKey(KEY));
      return stored ? JSON.parse(stored.body) : null;
    },
    setLedger: (jobs: unknown[]) =>
      objects.set(videoConversionLedgerKey(KEY), {
        body: JSON.stringify({ jobs }),
        etag: `ledger-${++version}`
      }),
    onNextPut: (hook: () => void) => {
      beforePut = hook;
    }
  };
}

function admit(
  s3: S3Client,
  overrides: Partial<Parameters<typeof admitVideoConversion>[0]> = {}
) {
  return admitVideoConversion({
    s3,
    bucket: BUCKET,
    key: KEY,
    eventEtag: 'v1',
    eventSize: 1000,
    eventId: 'event-1',
    limits: DEFAULT_VIDEO_CONVERSION_LIMITS,
    now: NOW,
    ...overrides
  });
}

describe('admitVideoConversion', () => {
  it('admits a new object version and records its job', async () => {
    const bucket = fakeS3();

    await expect(admit(bucket.s3)).resolves.toEqual({
      convert: true,
      etag: 'v1'
    });

    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]).toMatchObject({
      Bucket: BUCKET,
      Key: expect.stringMatching(
        /^_video-conversion-ledger\/v1\/[0-9a-f]{64}\.json$/
      ),
      IfNoneMatch: '*'
    });
    expect(bucket.ledger()).toEqual({
      jobs: [{ etag: 'v1', event: 'event-1', at: NOW }]
    });
  });

  it('skips a deleted object without touching the ledger', async () => {
    const bucket = fakeS3({ headError: s3Error('NotFound', 404) });

    await expect(admit(bucket.s3)).resolves.toEqual({
      convert: false,
      reason: 'missing'
    });
    expect(bucket.send).toHaveBeenCalledTimes(1);
  });

  it('skips a version replaced by a later write', async () => {
    const bucket = fakeS3({ videoEtag: 'v2' });

    await expect(admit(bucket.s3, { eventEtag: 'v1' })).resolves.toEqual({
      convert: false,
      reason: 'superseded'
    });
    expect(bucket.puts).toHaveLength(0);
  });

  it('skips an object above the size limit', async () => {
    const bucket = fakeS3({ videoSize: 2 * 1024 ** 3 + 1 });

    await expect(admit(bucket.s3)).resolves.toEqual({
      convert: false,
      reason: 'too_large',
      detail: { size: 2 * 1024 ** 3 + 1, max_bytes: 2 * 1024 ** 3 }
    });
    expect(bucket.puts).toHaveLength(0);
  });

  it('falls back to the size the event reported when HEAD is forbidden', async () => {
    const forbidden = fakeS3({ headError: s3Error('Forbidden', 403) });
    await expect(
      admit(forbidden.s3, { eventSize: 3 * 1024 ** 3 })
    ).resolves.toMatchObject({ convert: false, reason: 'too_large' });
    await expect(admit(forbidden.s3, { eventSize: null })).resolves.toEqual({
      convert: false,
      reason: 'unknown_size'
    });
    await expect(admit(forbidden.s3)).resolves.toEqual({
      convert: true,
      etag: 'v1'
    });
  });

  it('starts one job per object version: an identical re-upload is a duplicate', async () => {
    const bucket = fakeS3();
    await admit(bucket.s3);

    await expect(admit(bucket.s3, { eventId: 'event-2' })).resolves.toEqual({
      convert: false,
      reason: 'duplicate'
    });
    expect(bucket.puts).toHaveLength(1);
  });

  it('lets a redelivered event retry its own job without recording it again', async () => {
    const bucket = fakeS3();
    await admit(bucket.s3);

    await expect(admit(bucket.s3)).resolves.toEqual({
      convert: true,
      etag: 'v1'
    });
    expect(bucket.puts).toHaveLength(1);
  });

  it('caps jobs per key within the window and forgets older jobs', async () => {
    const bucket = fakeS3({ videoEtag: 'v4' });
    bucket.setLedger([
      { etag: 'old', event: 'e0', at: NOW - 25 * HOUR },
      { etag: 'v1', event: 'e1', at: NOW - 3 * HOUR },
      { etag: 'v2', event: 'e2', at: NOW - 2 * HOUR },
      { etag: 'v3', event: 'e3', at: NOW - HOUR }
    ]);

    await expect(
      admit(bucket.s3, { eventEtag: 'v4', eventId: 'e4' })
    ).resolves.toEqual({
      convert: false,
      reason: 'job_cap',
      detail: { jobs_in_window: 3, max_jobs_per_key: 3 }
    });

    // Once the oldest counted job leaves the window, another job may start.
    await expect(
      admit(bucket.s3, {
        eventEtag: 'v4',
        eventId: 'e4',
        now: NOW + 21 * HOUR + 1
      })
    ).resolves.toEqual({ convert: true, etag: 'v4' });
    expect(bucket.puts[0].IfMatch).toMatch(/^"ledger-\d+"$/);
    expect(
      bucket.ledger().jobs.map((job: { etag: string }) => job.etag)
    ).toEqual(['v2', 'v3', 'v4']);
  });

  it('decides again when a concurrent event changed the ledger first', async () => {
    const bucket = fakeS3();
    bucket.onNextPut(() =>
      bucket.setLedger([{ etag: 'v1', event: 'event-2', at: NOW }])
    );

    await expect(admit(bucket.s3)).resolves.toEqual({
      convert: false,
      reason: 'duplicate'
    });
    expect(bucket.puts).toHaveLength(0);
  });

  it('propagates other ledger failures for the Lambda retry', async () => {
    const bucket = fakeS3();
    bucket.onNextPut(() => {
      throw s3Error('SlowDown', 503);
    });

    await expect(admit(bucket.s3)).rejects.toThrow('SlowDown');
  });
});

describe('videoConversionLimitsFrom', () => {
  it('uses generous defaults and ignores invalid settings', () => {
    expect(videoConversionLimitsFrom({})).toEqual({
      maxBytes: 2 * 1024 ** 3,
      maxJobsPerKey: 3,
      windowMs: 24 * HOUR
    });
    expect(
      videoConversionLimitsFrom({
        DROP_VIDEO_CONVERSION_MAX_BYTES: '-1',
        DROP_VIDEO_CONVERSION_MAX_JOBS_PER_KEY: 'many',
        DROP_VIDEO_CONVERSION_JOB_WINDOW_HOURS: ''
      })
    ).toEqual(DEFAULT_VIDEO_CONVERSION_LIMITS);
  });

  it('reads configured limits', () => {
    expect(
      videoConversionLimitsFrom({
        DROP_VIDEO_CONVERSION_MAX_BYTES: '524288000',
        DROP_VIDEO_CONVERSION_MAX_JOBS_PER_KEY: '2',
        DROP_VIDEO_CONVERSION_JOB_WINDOW_HOURS: '6'
      })
    ).toEqual({ maxBytes: 524288000, maxJobsPerKey: 2, windowMs: 6 * HOUR });
  });
});
