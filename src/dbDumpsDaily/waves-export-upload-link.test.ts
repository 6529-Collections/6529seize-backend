import {
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { Logger } from '@/logging';
import { PrivateBucketError } from './chain-exports/private-export-bucket';
import {
  parseWavesExportUploadLinkEvent,
  putPresignerClientConfig,
  runWavesExportUploadLink,
  s3PutPresigner,
  uploadKeyOf,
  UPLOAD_LINK_DEFAULT_SECONDS,
  WavesExportJobEventError,
  WavesExportUploadLinkDeps
} from './waves-export.handler';

// Every link is signed by the real presigner; this records what it signed.
const mockGetSignedUrl = jest.fn((...args: unknown[]) =>
  jest.requireActual('@aws-sdk/s3-request-presigner').getSignedUrl(...args)
);
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args)
}));

// Made up: an account of zeros, a region that doesn't exist, and keys that
// sign offline only.
const OWNER = '000000000000';
const REGION = 'xx-test-1';
const BUCKET = `6529-chain-exports-${OWNER}-${REGION}`;
const FUNCTION_ARN = ['arn', 'aws', 'lambda', REGION, OWNER, 'function', 'x'];
const CREDENTIALS = { accessKeyId: 'MADEUPKEYID', secretAccessKey: 'made-up' };
const AT = Date.UTC(2026, 10, 26, 5, 55);

/** The bucket's two privacy reads; any other call fails the test. */
class FakeBucket {
  block: Record<string, boolean | undefined> = {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true
  };
  blockRefused = false;
  policyPublic: boolean | undefined = false;
  readonly calls: string[] = [];

  readonly send = jest.fn(async (command: any) => {
    this.calls.push(command.constructor.name);
    if (command.input.ExpectedBucketOwner !== OWNER) {
      throw new Error(`no ExpectedBucketOwner on ${command.constructor.name}`);
    }
    if (command.input.Bucket !== BUCKET) throw new Error('another bucket');
    if (command instanceof GetPublicAccessBlockCommand) {
      if (this.blockRefused) {
        throw Object.assign(new Error('AccessDenied'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 }
        });
      }
      return { PublicAccessBlockConfiguration: this.block };
    }
    if (command instanceof GetBucketPolicyStatusCommand) {
      return { PolicyStatus: { IsPublic: this.policyPublic } };
    }
    throw new Error(`unexpected ${command.constructor.name}`);
  });
}

function setup(requestId = 'request-1') {
  const bucket = new FakeBucket();
  const client = new S3Client({
    ...putPresignerClientConfig(REGION),
    credentials: CREDENTIALS
  });
  const deps: WavesExportUploadLinkDeps = {
    prepareEnvironment: jest.fn(async () => undefined),
    env: () => ({ AWS_REGION: REGION, NODE_ENV: 'development' }),
    s3: { send: bucket.send } as never,
    presignPut: s3PutPresigner(client),
    now: () => AT
  };
  const context = {
    invokedFunctionArn: FUNCTION_ARN.join(':'),
    awsRequestId: requestId
  };
  const link = (event: Record<string, unknown>) =>
    runWavesExportUploadLink(
      parseWavesExportUploadLinkEvent({
        job: 'wavesExport',
        action: 'upload-link',
        ...event
      })!,
      context,
      deps
    );
  return { bucket, deps, link };
}

describe('the upload link event', () => {
  const parse = (event: Record<string, unknown>) =>
    parseWavesExportUploadLinkEvent({
      job: 'wavesExport',
      action: 'upload-link',
      ...event
    });

  it('reads a name and the seconds, 7200 when not given', () => {
    expect(parse({ name: 'drops-1.tar.gz' })).toEqual({
      job: 'wavesExport',
      action: 'upload-link',
      name: 'drops-1.tar.gz',
      seconds: UPLOAD_LINK_DEFAULT_SECONDS
    });
    expect(UPLOAD_LINK_DEFAULT_SECONDS).toBe(7_200);
    expect(parse({ name: 'a', seconds: 60 })?.seconds).toBe(60);
    expect(parse({ name: 'a', seconds: 21_600 })?.seconds).toBe(21_600);
    expect(parse({ name: 'x'.repeat(100) })?.name).toBe('x'.repeat(100));
  });

  it("leaves any other event to the export's own reading", () => {
    expect(parseWavesExportUploadLinkEvent({ job: 'wavesExport' })).toBe(null);
    expect(
      parseWavesExportUploadLinkEvent({
        job: 'identityExport',
        action: 'upload-link',
        name: 'a'
      })
    ).toBe(null);
    expect(parseWavesExportUploadLinkEvent(null)).toBe(null);
    expect(parseWavesExportUploadLinkEvent([])).toBe(null);
  });

  it.each([
    ['a slash', 'archives/drops.tar.gz'],
    ['a backslash', 'archives\\drops.tar.gz'],
    ['..', '..'],
    ['.. inside', 'drops..tar.gz'],
    ['a space', 'drops 1.tar.gz'],
    ['a character outside the set', 'drops?.tar.gz'],
    ['an empty name', ''],
    ['a name over 100 characters', 'x'.repeat(101)],
    ['a name that is not text', 7]
  ])('refuses %s', (_, name) => {
    expect(() => parse({ name })).toThrow(WavesExportJobEventError);
    expect(() => parse({ name })).toThrow(/name must be a plain file name/);
  });

  it('refuses a missing name', () => {
    expect(() => parse({})).toThrow(/name must be a plain file name/);
  });

  it.each([[59], [21_601], [0], [-60], [600.5], ['600'], [null]])(
    'refuses seconds %j',
    (seconds) => {
      expect(() => parse({ name: 'a', seconds })).toThrow(
        /seconds must be a whole number from 60 to 21600/
      );
    }
  );

  it('refuses another action, and fields the action does not take', () => {
    expect(() => parse({ action: 'download-link', name: 'a' })).toThrow(
      /action must be "upload-link"/
    );
    expect(() =>
      parse({ name: 'a', freezeAt: '2026-11-26T00:00:00Z' })
    ).toThrow(/Unknown fields for upload-link: freezeAt/);
  });
});

describe('the upload link', () => {
  beforeEach(() => mockGetSignedUrl.mockClear());

  it('signs one PUT of its own key, after the privacy check, and returns only the link, key and expiry', async () => {
    const info = jest.spyOn(Logger.prototype, 'info');
    try {
      const run = setup();
      const link = await run.link({ name: 'drops-1.tar.gz', seconds: 3_600 });
      expect(Object.keys(link).sort()).toEqual(['expiresAt', 'key', 'putUrl']);
      expect(link.key).toBe(
        'waves-export/staging/uploads/2026-11-26T05-55-00-000Z-request1-drops-1.tar.gz'
      );
      expect(link.expiresAt).toBe('2026-11-26T06:55:00.000Z');
      // The bucket's privacy first, then the one signing.
      expect(run.bucket.calls).toEqual([
        'GetPublicAccessBlockCommand',
        'GetBucketPolicyStatusCommand'
      ]);
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
      const [, command, options] = mockGetSignedUrl.mock.calls[0] as [
        unknown,
        PutObjectCommand,
        { expiresIn: number }
      ];
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toEqual({
        Bucket: BUCKET,
        Key: link.key,
        ExpectedBucketOwner: OWNER
      });
      expect(options).toEqual({ expiresIn: 3_600 });
      // The link: that key, for that long, the owner in its query, and no
      // checksum signed into it (S3 would refuse the file against it).
      const url = new URL(link.putUrl);
      expect(decodeURIComponent(url.pathname)).toBe(`/${link.key}`);
      expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
      expect(url.searchParams.get('x-amz-expected-bucket-owner')).toBe(OWNER);
      expect(
        Array.from(url.searchParams.keys()).filter((name) =>
          /checksum/i.test(name)
        )
      ).toEqual([]);
      // The log names the key and the expiry, never the link.
      const logged = info.mock.calls.map((call) => call.join(' '));
      expect(logged).toContainEqual(
        `[UPLOAD LINK] [${link.key}] [EXPIRES ${link.expiresAt}]`
      );
      expect(logged.join('\n')).not.toContain('X-Amz-Signature');
      expect(logged.join('\n')).not.toContain(url.search);
    } finally {
      info.mockRestore();
    }
  });

  it('signs the default 7200 seconds', async () => {
    const link = await setup().link({ name: 'drops-1.tar.gz' });
    expect(link.expiresAt).toBe('2026-11-26T07:55:00.000Z');
    expect(new URL(link.putUrl).searchParams.get('X-Amz-Expires')).toBe('7200');
  });

  it("never names an earlier link's key", async () => {
    const first = await setup('request-1').link({ name: 'drops.tar.gz' });
    const second = await setup('request-2').link({ name: 'drops.tar.gz' });
    expect(second.key).not.toBe(first.key);
    expect(
      uploadKeyOf('prod', new Date(AT + 1), 'request-1', 'drops.tar.gz')
    ).not.toBe(uploadKeyOf('prod', new Date(AT), 'request-1', 'drops.tar.gz'));
    expect(() =>
      uploadKeyOf('prod', new Date(AT), 'request-1', '../drops.tar.gz')
    ).toThrow(WavesExportJobEventError);
  });

  it.each([
    [
      'a bucket that does not block every kind of public access',
      (bucket: FakeBucket) => (bucket.block.BlockPublicPolicy = false),
      /does not block all public access/
    ],
    [
      'a public access block it cannot read',
      (bucket: FakeBucket) => (bucket.blockRefused = true),
      /Can't read the public access block .*AccessDenied \(403\)/
    ],
    [
      'a public access block with a setting missing',
      (bucket: FakeBucket) => delete bucket.block.RestrictPublicBuckets,
      /does not block all public access/
    ],
    [
      'a policy S3 does not call private',
      (bucket: FakeBucket) => (bucket.policyPublic = undefined),
      /does not say .* policy is private/
    ],
    [
      'a public policy',
      (bucket: FakeBucket) => (bucket.policyPublic = true),
      /does not say .* policy is private/
    ]
  ])('refuses %s, signing nothing', async (_, make, message) => {
    const run = setup();
    make(run.bucket);
    const link = run.link({ name: 'drops.tar.gz' });
    await expect(link).rejects.toThrow(PrivateBucketError);
    await expect(link).rejects.toThrow(message);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("signs with the client's default a checksum S3 would hold the file to, which the link's client leaves out", async () => {
    const url = await s3PutPresigner(
      new S3Client({ region: REGION, credentials: CREDENTIALS })
    )({ name: BUCKET, owner: OWNER }, 'waves-export/staging/uploads/a', 600);
    expect(
      Array.from(new URL(url).searchParams.keys()).some((name) =>
        /checksum/i.test(name)
      )
    ).toBe(true);
  });
});
