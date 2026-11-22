import {
  GetBucketPolicyStatusCommand,
  GetPublicAccessBlockCommand
} from '@aws-sdk/client-s3';
import {
  accountIdFromFunctionArn,
  assertBucketPrivate,
  chainExportsBucketName,
  PrivateBucketError,
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

  it('puts each run under its own prefix', () => {
    expect(
      runPrefix(
        'profile-site-export',
        'Prod!',
        new Date(Date.UTC(2026, 10, 24, 0, 0, 5)),
        'abc-def-123456'
      )
    ).toBe('profile-site-export/prod/2026-11-24T00-00-05-000Z-abcdef12/');
  });
});
