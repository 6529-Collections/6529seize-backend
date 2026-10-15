import { ApiIdentitySubscriptionTargetAction } from '@/api/generated/models/ApiIdentitySubscriptionTargetAction';
import { IdentitiesService } from './identities.service';

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual('@aws-sdk/client-s3'),
  S3Client: jest.fn(() => ({ send: mockS3Send }))
}));
jest.mock('@/profileActivityLogs/profile-activity-logs.db', () => ({
  profileActivityLogsDb: { insert: jest.fn() }
}));

describe('IdentitiesService subscriptions', () => {
  it('rejects following a profile blocked by the subscriber', async () => {
    const connection = {} as any;
    const identitiesDb = {
      getEverythingRelatedToIdentitiesByAddresses: jest.fn().mockResolvedValue({
        '0xtarget': { identity: { profile_id: 'target-profile' } }
      })
    };
    const identitySubscriptionsDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (executable: (connection: any) => Promise<unknown>) =>
          executable(connection)
      ),
      findIdentitySubscriptionActionsOfTarget: jest.fn()
    };
    const contentModerationDb = {
      isProfileBlocked: jest.fn().mockResolvedValue(true)
    };
    const service = new IdentitiesService(
      identitiesDb as any,
      identitySubscriptionsDb as any,
      {} as any,
      {} as any,
      contentModerationDb as any
    );

    await expect(
      service.addIdentitySubscriptionActions({
        subscriber: 'viewer-profile',
        identityAddress: '0xtarget',
        actions: [ApiIdentitySubscriptionTargetAction.DropCreated]
      })
    ).rejects.toThrow(`You can't follow a profile you have blocked`);

    expect(contentModerationDb.isProfileBlocked).toHaveBeenCalledWith(
      'viewer-profile',
      'target-profile',
      connection
    );
    expect(
      identitySubscriptionsDb.findIdentitySubscriptionActionsOfTarget
    ).not.toHaveBeenCalled();
  });
});

describe('IdentitiesService profile pictures', () => {
  it('uploads a new picture to a fresh key with long-lived caching', async () => {
    process.env.AWS_6529_IMAGES_BUCKET_NAME = 'images-bucket';
    mockS3Send.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    const identitiesDb = {
      executeNativeQueriesInTransaction: jest.fn(
        async (executable: (connection: any) => Promise<unknown>) =>
          executable({})
      ),
      updateProfilePfpUri: jest.fn()
    };
    const identityFetcher = {
      getIdentityAndConsolidationsByIdentityKey: jest.fn().mockResolvedValue({
        id: 'profile-1',
        handle: 'someone',
        pfp: null,
        wallets: [{ wallet: '0xwallet' }]
      })
    };
    const service = new IdentitiesService(
      identitiesDb as any,
      {} as any,
      {} as any,
      identityFetcher as any,
      {} as any
    );

    const { pfp_url } = await service.updateProfilePfp({
      authenticatedWallet: '0xwallet',
      identity: 'someone',
      memeOrFile: {
        file: {
          originalname: 'avatar.PNG',
          buffer: Buffer.from('image')
        } as Express.Multer.File
      }
    });

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const input = mockS3Send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Bucket: 'images-bucket',
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable'
    });
    expect(input.Key).toMatch(/^pfp\/[^/]+\/[0-9a-f-]{36}\.webp$/);
    expect(pfp_url).toContain(`/${input.Key}?d=`);
  });
});
