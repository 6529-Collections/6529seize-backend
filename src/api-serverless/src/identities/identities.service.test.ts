import { ApiIdentitySubscriptionTargetAction } from '@/api/generated/models/ApiIdentitySubscriptionTargetAction';
import { IdentitiesService } from './identities.service';
import { PROFILE_PICTURE_MAX_BYTES } from '@/api/profiles/profile-picture-ipfs-upload';
import {
  IDENTIFYING_STRINGS,
  identifyingJpeg
} from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import { stripMetadataLosslessly } from '@/media/metadata-strip/lossless-metadata-strip';

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

// A complete 1x1 RGBA PNG.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000970485973000003e8000003e801b57b526b0000000d4944415408996330' +
    '4e9bd9000003b501b388f521dd0000000049454e44ae426082',
  'hex'
);

function createPfpService() {
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
  const service = new IdentitiesService(
    identitiesDb as any,
    {} as any,
    {} as any,
    identityFetcher as any,
    {} as any
  );
  const upload = (buffer: Buffer, originalname = 'avatar.PNG') =>
    service.updateProfilePfp({
      authenticatedWallet: '0xwallet',
      identity: 'someone',
      memeOrFile: {
        file: { originalname, buffer } as Express.Multer.File
      }
    });
  return { service, identitiesDb, upload };
}

describe('IdentitiesService profile pictures', () => {
  it('uploads a new picture to a fresh key with long-lived caching', async () => {
    const { upload } = createPfpService();

    const { pfp_url } = await upload(PNG);

    expect(mockS3Send).toHaveBeenCalledTimes(1);
    const input = mockS3Send.mock.calls[0][0].input;
    expect(input).toMatchObject({
      Bucket: 'images-bucket',
      ContentType: 'image/png',
      CacheControl: 'public, max-age=31536000, immutable'
    });
    expect(input.Key).toMatch(/^pfp\/[^/]+\/[0-9a-f-]{36}\.png$/);
    expect(pfp_url).toMatch(
      /^https:\/\/d3lqz0a4bldqgf\.cloudfront\.net\/pfp\/[^/]+\/[0-9a-f-]{36}\.png\?d=\d+$/
    );
    expect(pfp_url).toContain(`/${input.Key}?d=`);
  });

  it('stores a JPEG without its GPS, camera or owner metadata, labelled by its bytes', async () => {
    const { upload } = createPfpService();
    const { jpeg } = await identifyingJpeg();

    await upload(jpeg, 'holiday.webp');

    const input = mockS3Send.mock.calls[0][0].input;
    expect(input.ContentType).toBe('image/jpeg');
    expect(input.Key).toMatch(/\.jpg$/);
    expect(input.Body).toEqual(stripMetadataLosslessly(jpeg, 'jpeg').output);
    const text = Buffer.from(input.Body).toString('latin1');
    for (const value of IDENTIFYING_STRINGS) {
      expect(text).not.toContain(value);
    }
  });

  it.each([
    ['an HTML page', '<!doctype html><html></html>', 'avatar.png'],
    ['an SVG image', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'a.gif'],
    ['plain text', 'image', 'avatar.jpg']
  ])(
    'refuses %s sent with an image file name, storing nothing',
    async (_, text, name) => {
      const { upload, identitiesDb } = createPfpService();

      await expect(upload(Buffer.from(text, 'latin1'), name)).rejects.toThrow(
        'Profile picture must be a PNG, JPEG, GIF or WebP image'
      );
      expect(mockS3Send).not.toHaveBeenCalled();
      expect(identitiesDb.updateProfilePfpUri).not.toHaveBeenCalled();
    }
  );

  it('refuses a picture above the size limit', async () => {
    const { upload } = createPfpService();
    const tooLarge = Buffer.concat([
      PNG,
      Buffer.alloc(PROFILE_PICTURE_MAX_BYTES)
    ]);

    await expect(upload(tooLarge)).rejects.toThrow(
      'Profile picture is too large'
    );
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('refuses a picture whose metadata cannot be removed', async () => {
    const { upload } = createPfpService();
    const { jpeg } = await identifyingJpeg();

    await expect(upload(jpeg.subarray(0, jpeg.length - 64))).rejects.toThrow(
      'could not be cleaned of its metadata'
    );
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
