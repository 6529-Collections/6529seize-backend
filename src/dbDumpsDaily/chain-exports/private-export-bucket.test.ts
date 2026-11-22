import {
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  accountIdFromFunctionArn,
  assertBucketPrivate,
  chainExportsBucketName,
  exportBucketOf,
  exportStage,
  linksLastAtMost,
  PRESIGNED_URL_SECONDS,
  PrivateBucketError,
  PrivateExportWriter,
  runPrefix,
  s3Presigner
} from './private-export-bucket';

const OWNER = '000000000000';
const BUCKET = { name: 'b', owner: OWNER };

describe('the chain exports bucket', () => {
  it('is named from the function ARN and its region, owned by its account', () => {
    expect(
      exportBucketOf(
        `arn:aws:lambda:us-east-1:${OWNER}:function:dbDumpsDaily`,
        'us-east-1'
      )
    ).toEqual({
      name: `6529-chain-exports-${OWNER}-us-east-1`,
      owner: OWNER
    });
    expect(() => accountIdFromFunctionArn(undefined)).toThrow(
      PrivateBucketError
    );
    expect(() => chainExportsBucketName(OWNER, '')).toThrow(PrivateBucketError);
  });

  function s3(
    block: Record<string, boolean>,
    isPublic: boolean | undefined,
    failStatus = false
  ) {
    const commands: any[] = [];
    return {
      commands,
      send: jest.fn(async (command: any) => {
        commands.push(command);
        if (command instanceof GetPublicAccessBlockCommand) {
          return { PublicAccessBlockConfiguration: block };
        }
        if (command instanceof GetBucketPolicyStatusCommand) {
          if (failStatus) throw new Error('AccessDenied');
          return { PolicyStatus: { IsPublic: isPublic } };
        }
        throw new Error('unexpected');
      })
    };
  }
  const allBlocked = {
    BlockPublicAcls: true,
    IgnorePublicAcls: true,
    BlockPublicPolicy: true,
    RestrictPublicBuckets: true
  };

  it('is private only with every block on and a policy S3 calls private, asked of its owner', async () => {
    const ok = s3(allBlocked, false);
    await expect(assertBucketPrivate(ok, BUCKET)).resolves.toEqual({
      bucket: 'b',
      owner: OWNER,
      publicAccessBlocked: true,
      policyPublic: false
    });
    expect(ok.commands.map((c) => c.input.ExpectedBucketOwner)).toEqual([
      OWNER,
      OWNER
    ]);
    for (const off of Object.keys(allBlocked)) {
      await expect(
        assertBucketPrivate(s3({ ...allBlocked, [off]: false }, false), BUCKET)
      ).rejects.toThrow(PrivateBucketError);
    }
    await expect(
      assertBucketPrivate(s3(allBlocked, true), BUCKET)
    ).rejects.toThrow(PrivateBucketError);
    await expect(
      assertBucketPrivate(s3(allBlocked, undefined), BUCKET)
    ).rejects.toThrow(PrivateBucketError);
    await expect(
      assertBucketPrivate(s3(allBlocked, false, true), BUCKET)
    ).rejects.toThrow(/policy status/);
  });

  it('names the stage as prod or staging from NODE_ENV', () => {
    expect(exportStage('production')).toBe('prod');
    expect(exportStage('development')).toBe('staging');
    expect(exportStage('local')).toBe('local');
    expect(exportStage(undefined)).toBe('unknown');
  });

  it('puts each run under its own prefix', () => {
    expect(
      runPrefix(
        'profile-site-export',
        'Prod!',
        new Date(Date.UTC(2026, 10, 24, 0, 0, 5)),
        'abc-def-123456'
      )
    ).toBe('profile-site-export/prod/2026-11-24T00-00-05-000Z-abcdef12/');
    expect(
      runPrefix(
        'profile-site-export',
        'staging',
        new Date(Date.UTC(2026, 10, 24)),
        'abc',
        'rehearsal-profile-a/b'
      )
    ).toBe(
      'profile-site-export/staging/2026-11-24T00-00-00-000Z-abc-rehearsal-profile-ab/'
    );
  });

  it('says how long the links last at most', () => {
    const now = new Date(Date.UTC(2026, 10, 24));
    expect(linksLastAtMost(now)).toEqual(
      new Date(now.getTime() + PRESIGNED_URL_SECONDS * 1000)
    );
  });

  it('writes each object as its owner, with a checksum S3 verifies, and returns its digest', async () => {
    const commands: any[] = [];
    const send = jest.fn(async (command: any) => {
      commands.push(command);
      return {};
    });
    const writer = new PrivateExportWriter({ send } as never, BUCKET, 'p/');
    await expect(
      writer.put('x.json', 'abc', 'application/json')
    ).resolves.toEqual({
      key: 'p/x.json',
      bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    });
    await writer.putOutside('pointer.json', '{}', 'application/json');
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect(commands[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'p/x.json',
      ExpectedBucketOwner: OWNER,
      ChecksumSHA256: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='
    });
    expect(commands[1].input).toMatchObject({
      Key: 'pointer.json',
      ExpectedBucketOwner: OWNER
    });
    // The pointer sits outside the run: it isn't counted as the run's.
    expect(writer.files).toBe(1);
    expect(writer.bytes).toBe(3);
  });

  it.each([
    [{ name: 'NoSuchKey' }, { found: false, reason: 'missing' }],
    [{ name: 'AccessDenied' }, { found: false, reason: 'forbidden' }],
    [
      { name: 'Unknown', $metadata: { httpStatusCode: 403 } },
      { found: false, reason: 'forbidden' }
    ]
  ])('reads %j as %j', async (error, expected) => {
    const send = jest.fn(async () => {
      throw Object.assign(new Error('no'), error);
    });
    const writer = new PrivateExportWriter({ send } as never, BUCKET, 'p/');
    await expect(writer.read('m.json')).resolves.toEqual(expected);
  });

  it('reads an object as its owner, and rethrows other errors', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ Body: { transformToString: async () => 'hi' } })
      .mockRejectedValueOnce(
        Object.assign(new Error('slow'), { name: 'Timeout' })
      );
    const writer = new PrivateExportWriter({ send } as never, BUCKET, 'p/');
    await expect(writer.read('m.json')).resolves.toEqual({
      found: true,
      text: 'hi'
    });
    const get = send.mock.calls[0][0] as GetObjectCommand;
    expect(get.input).toMatchObject({
      Key: 'p/m.json',
      ExpectedBucketOwner: OWNER
    });
    await expect(writer.read('m.json')).rejects.toThrow('slow');
  });

  it('reads a key outside the run, as its owner, with the same answers', async () => {
    const send = jest
      .fn()
      .mockResolvedValueOnce({ Body: { transformToString: async () => '{}' } })
      .mockRejectedValueOnce(
        Object.assign(new Error('no'), { name: 'NoSuchKey' })
      );
    const writer = new PrivateExportWriter({ send } as never, BUCKET, 'p/');
    await expect(writer.readOutside('x/by-freeze/t.json')).resolves.toEqual({
      found: true,
      text: '{}'
    });
    expect((send.mock.calls[0][0] as GetObjectCommand).input).toMatchObject({
      Key: 'x/by-freeze/t.json',
      ExpectedBucketOwner: OWNER
    });
    await expect(writer.readOutside('x/by-freeze/u.json')).resolves.toEqual({
      found: false,
      reason: 'missing'
    });
  });

  it('presigns links that carry the expected owner in their query', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'x' }
    });
    const url = new URL(await s3Presigner(client)(BUCKET, 'p/m.json', 60));
    expect(url.searchParams.get('x-amz-expected-bucket-owner')).toBe(OWNER);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});
