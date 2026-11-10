import { identitiesDb } from '@/identities/identities.db';
import { ProfileClassification } from '@/entities/IProfile';
import { profilesService } from '@/profiles/profiles.service';

const WALLET = '0x' + '11'.repeat(20);
const LEGACY_PFP = 'https://d3lqz0a4bldqgf.example.com/legacy.png';
const CDN_PFP = 'https://d3lqz0a4bldqgf.cloudfront.net/pfp/production/a.webp';
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';

/**
 * The stored profile has a picture saved before the allowlist existed.
 * Another profile owns the submitted handle, so a request that passes the
 * picture check stops at the handle check before any write.
 */
function givenStoredPicture(pfp: string | null) {
  jest
    .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
    .mockResolvedValue({
      [WALLET]: {
        identity: {
          profile_id: 'profile-1',
          primary_address: WALLET,
          consolidation_key: WALLET,
          pfp
        },
        profile: {
          external_id: 'profile-1',
          normalised_handle: 'someone',
          pfp_url: pfp ?? undefined
        }
      }
    } as never);
  return jest
    .spyOn(identitiesDb, 'getIdentityByHandle')
    .mockResolvedValue({ profile_id: 'profile-2' } as never);
}

function update(pfp_url: string | null) {
  return profilesService.createOrUpdateProfileWithGivenTransaction(
    {
      handle: 'taken',
      banner_1: undefined,
      banner_2: undefined,
      website: undefined,
      creator_or_updater_wallet: WALLET,
      classification: ProfileClassification.PSEUDONYM,
      sub_classification: null,
      pfp_url
    } as never,
    { connection: {} as never }
  );
}

describe('profile update picture check', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps an unchanged stored picture that predates the allowlist', async () => {
    const handleLookup = givenStoredPicture(LEGACY_PFP);
    await expect(update(LEGACY_PFP)).rejects.toThrow('already taken');
    expect(handleLookup).toHaveBeenCalled();
  });

  it('rejects changing to a picture outside the allowlist', async () => {
    const handleLookup = givenStoredPicture(CDN_PFP);
    await expect(update(LEGACY_PFP)).rejects.toThrow('Profile picture must be');
    expect(handleLookup).not.toHaveBeenCalled();
  });

  it.each([CDN_PFP, `ipfs://${CID}`, null])(
    'accepts changing to %p',
    async (next) => {
      const handleLookup = givenStoredPicture(LEGACY_PFP);
      await expect(update(next)).rejects.toThrow('already taken');
      expect(handleLookup).toHaveBeenCalled();
    }
  );
});
