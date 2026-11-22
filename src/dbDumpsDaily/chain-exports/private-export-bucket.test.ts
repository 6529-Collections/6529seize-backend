import {
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand
} from '@aws-sdk/client-s3';
import {
  accountIdFromFunctionArn,
  assertBucketPrivate,
  chainExportsBucketName,
  exportStage,
  linksExpireAt,
  PrivateBucketError,
  PrivateExportWriter,
  runPrefix
} from './private-export-bucket';

describe('the chain exports bucket', () => {
  it('is named from the function ARN and its region', () => {
    const account = accountIdFromFunctionArn(
      'arn:aws:lambda:us-east-1:000000000000:function:dbDumpsDaily'
    );
    expect(chainExportsBucketName(account, 'us-east-1')).toBe(
      '6529-chain-exports-000000000000-us-east-1'
    );
    expect(() => accountIdFromFunctionArn(undefined)).toThrow(
      PrivateBucketError
    );
    expect(() => chainExportsBucketName(account, '')).toThrow(
      PrivateBucketError
    );
  });

  function s3(
    block: Record<string, boolean>,
    isPublic: boolean | undefined,
    failStatus = false
  ) {
    return {
      send: jest.fn(async (command: any) => {
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

  it('is private only with every block on and a policy S3 calls private', async () => {
    await expect(
      assertBucketPrivate(s3(allBlocked, false), 'b')
    ).resolves.toEqual({
      bucket: 'b',
      publicAccessBlocked: true,
      policyPublic: false
    });
    for (const off of Object.keys(allBlocked)) {
      await expect(
        assertBucketPrivate(s3({ ...allBlocked, [off]: false }, false), 'b')
      ).rejects.toThrow(PrivateBucketError);
    }
    await expect(
      assertBucketPrivate(s3(allBlocked, true), 'b')
    ).rejects.toThrow(PrivateBucketError);
    await expect(
      assertBucketPrivate(s3(allBlocked, undefined), 'b')
    ).rejects.toThrow(PrivateBucketError);
    await expect(
      assertBucketPrivate(s3(allBlocked, false, true), 'b')
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
        'profile-a/b'
      )
    ).toBe(
      'profile-site-export/staging/2026-11-24T00-00-00-000Z-abc-profile-ab/'
    );
  });

  it('ends the links at six hours or when the credentials end, whichever is first', () => {
    const now = new Date(Date.UTC(2026, 10, 24));
    expect(linksExpireAt(now, null)).toEqual({
      at: new Date(now.getTime() + 6 * 3600_000),
      limitedByCredentials: false
    });
    const soon = new Date(now.getTime() + 3600_000);
    expect(linksExpireAt(now, soon)).toEqual({
      at: soon,
      limitedByCredentials: true
    });
  });

  it('returns each object it writes with its size and sha256', async () => {
    const send = jest.fn(async () => ({}));
    const writer = new PrivateExportWriter({ send } as never, 'b', 'p/');
    await expect(
      writer.put('x.json', 'abc', 'application/json')
    ).resolves.toEqual({
      key: 'p/x.json',
      bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    });
    expect(writer.files).toBe(1);
    expect(writer.bytes).toBe(3);
  });
});
