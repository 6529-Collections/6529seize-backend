import { ApiIdentitySubscriptionTargetAction } from '@/api/generated/models/ApiIdentitySubscriptionTargetAction';
import Sharp from 'sharp';
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
  function createService() {
    process.env.AWS_6529_IMAGES_BUCKET_NAME = 'images-bucket';
    mockS3Send.mockReset();
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
    return new IdentitiesService(
      identitiesDb as any,
      {} as any,
      {} as any,
      identityFetcher as any,
      {} as any
    );
  }

  function upload(
    service: IdentitiesService,
    file: Partial<Express.Multer.File>
  ) {
    return service.updateProfilePfp({
      authenticatedWallet: '0xwallet',
      identity: 'someone',
      memeOrFile: { file: file as Express.Multer.File }
    });
  }

  it('uploads a new picture to a fresh key typed from its bytes', async () => {
    const service = createService();
    const png = await Sharp({
      create: { width: 2, height: 2, channels: 3, background: '#ff0000' }
    })
      .png()
      .toBuffer();

    // The client file name is ignored; the bytes decide the stored type.
    const { pfp_url } = await upload(service, {
      originalname: 'avatar.webp',
      buffer: png
    });

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const input = mockS3Send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Bucket: 'images-bucket',
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable'
    });
    expect(input.Key).toMatch(/^pfp\/[^/]+\/[0-9a-f-]{36}\.png$/);
    expect(pfp_url).toContain(`/${input.Key}?d=`);
  });

  it.each([
    ['markup named as an image', Buffer.from('<svg></svg>'), 400],
    ['an oversized file', Buffer.alloc(2 * 1024 * 1024 + 1, 0xff), 413]
  ])('rejects %s without uploading it', async (_label, buffer, status) => {
    const service = createService();
    const error = await upload(service, {
      originalname: 'avatar.png',
      buffer
    }).catch((e) => e);
    expect(error.getStatusCode()).toBe(status);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
