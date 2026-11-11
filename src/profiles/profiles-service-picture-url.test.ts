import { identitiesDb } from '@/identities/identities.db';
import { ProfileClassification } from '@/entities/IProfile';
import { ProfilesService } from './profiles.service';

const WALLET = '0x1111111111111111111111111111111111111111';
const LOOK_ALIKE = 'https://d3lqz0a4bldqgf.cloudfront.net.example/pfp.png';
const STORED_OK =
  'https://d3lqz0a4bldqgf.cloudfront.net/pfp/production/a.webp?d=1';

/** Stops the update right after the picture URL check. */
const PAST_PICTURE_CHECK = 'reached the handle lookup after the picture check';

function createService(storedPfp: string | null) {
  jest
    .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
    .mockResolvedValue({
      [WALLET]: {
        consolidations: [],
        identity: { profile_id: 'profile-1', pfp: storedPfp },
        profile: { external_id: 'profile-1', pfp_url: storedPfp ?? undefined }
      }
    } as any);
  const instanceIdentitiesDb = {
    getIdentityByHandle: jest
      .fn()
      .mockRejectedValue(new Error(PAST_PICTURE_CHECK))
  };
  const profilesDb = {
    executeNativeQueriesInTransaction: jest.fn(
      async (work: (connection: unknown) => Promise<unknown>) => work({})
    ),
    updateProfileRecord: jest.fn(),
    insertProfileRecord: jest.fn()
  };
  const deps: unknown[] = Array(15).fill({});
  deps[0] = profilesDb;
  deps[5] = instanceIdentitiesDb;
  const service = new (ProfilesService as any)(...deps) as ProfilesService;
  const save = (pfp_url: string | null) =>
    service.createOrUpdateProfile({
      handle: 'someone',
      creator_or_updater_wallet: WALLET,
      classification: ProfileClassification.PSEUDONYM,
      sub_classification: null,
      pfp_url
    });
  return { save, profilesDb };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ProfilesService picture URL on profile edits', () => {
  it('accepts a stored picture URL that fails the exact checks when it is resent unchanged', async () => {
    const { save } = createService(LOOK_ALIKE);

    await expect(save(LOOK_ALIKE)).rejects.toThrow(PAST_PICTURE_CHECK);
  });

  it('refuses a changed picture URL that fails the exact checks, before writing', async () => {
    const { save, profilesDb } = createService(STORED_OK);

    await expect(save(LOOK_ALIKE)).rejects.toThrow(
      'Profile picture must be an ipfs:// link'
    );
    expect(profilesDb.updateProfileRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['the stored media host URL', STORED_OK],
    ['a new media host URL', 'https://d3lqz0a4bldqgf.cloudfront.net/x.png'],
    ['a bare CID', 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'],
    ['no picture', null]
  ])('lets %s through', async (_, pfp) => {
    const { save } = createService(STORED_OK);

    await expect(save(pfp)).rejects.toThrow(PAST_PICTURE_CHECK);
  });
});
