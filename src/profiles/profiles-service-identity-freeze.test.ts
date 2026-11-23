import { identitiesDb } from '@/identities/identities.db';
import { ProfileClassification } from '@/entities/IProfile';
import { IdentityFrozenException } from '@/identity-freeze/identity-freeze';
import { identitiesService } from '@/api/identities/identities.service';
import { ProfilesService } from './profiles.service';

const FLAG = 'FEATURE_IDENTITY_FROZEN';
const WALLET = '0x1111111111111111111111111111111111111111';
const PAST_FREEZE = 'reached the identity lookup after the freeze check';

function createService() {
  const lookup = jest
    .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
    .mockRejectedValue(new Error(PAST_FREEZE));
  const profilesDb = {
    executeNativeQueriesInTransaction: jest.fn(
      async (work: (connection: unknown) => Promise<unknown>) => work({})
    ),
    updateProfileRecord: jest.fn(),
    insertProfileRecord: jest.fn()
  };
  const deps: unknown[] = Array(15).fill({});
  deps[0] = profilesDb;
  const service = new (ProfilesService as any)(...deps) as ProfilesService;
  return { service, profilesDb, lookup };
}

describe('ProfilesService during the identity freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it.each([
    ['a profile edit', 'someone'],
    ['an implicit profile for a rated wallet', `id-${WALLET}`]
  ])('refuses %s before reading or writing', async (_, handle) => {
    process.env[FLAG] = 'true';
    const { service, profilesDb, lookup } = createService();
    await expect(
      service.createOrUpdateProfile({
        handle,
        creator_or_updater_wallet: WALLET,
        classification: ProfileClassification.PSEUDONYM,
        sub_classification: null,
        pfp_url: null
      })
    ).rejects.toBeInstanceOf(IdentityFrozenException);
    expect(lookup).not.toHaveBeenCalled();
    expect(profilesDb.insertProfileRecord).not.toHaveBeenCalled();
    expect(profilesDb.updateProfileRecord).not.toHaveBeenCalled();
  });

  it('works as before when the flag is off', async () => {
    delete process.env[FLAG];
    const { service } = createService();
    await expect(
      service.createOrUpdateProfile({
        handle: 'someone',
        creator_or_updater_wallet: WALLET,
        classification: ProfileClassification.PSEUDONYM,
        sub_classification: null,
        pfp_url: null
      })
    ).rejects.toThrow(PAST_FREEZE);
  });
});

describe('IdentitiesService.bulkCreateIdentities during the identity freeze', () => {
  const original = process.env[FLAG];
  afterEach(() => {
    jest.restoreAllMocks();
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  function mockExisting(existing: Record<string, unknown>) {
    jest
      .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
      .mockResolvedValue(existing as any);
    return jest
      .spyOn(identitiesDb, 'bulkInsertIdentities')
      .mockResolvedValue(undefined as any);
  }

  it('refuses to make an identity for a wallet that has none', async () => {
    process.env[FLAG] = 'true';
    const insert = mockExisting({});
    await expect(
      identitiesService.bulkCreateIdentities([WALLET], {
        connection: {} as any
      })
    ).rejects.toBeInstanceOf(IdentityFrozenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses to make a profile for an identity that has none', async () => {
    process.env[FLAG] = 'true';
    const insert = mockExisting({
      [WALLET]: {
        identity: { profile_id: 'p-1', primary_address: WALLET },
        profile: null,
        consolidations: []
      }
    });
    await expect(
      identitiesService.bulkCreateIdentities([WALLET], {
        connection: {} as any
      })
    ).rejects.toBeInstanceOf(IdentityFrozenException);
    expect(insert).not.toHaveBeenCalled();
  });

  it('lets wallets that already have a profile through', async () => {
    process.env[FLAG] = 'true';
    const insert = mockExisting({
      [WALLET]: {
        identity: { profile_id: 'p-1', primary_address: WALLET },
        profile: { external_id: 'p-1' },
        consolidations: []
      }
    });
    await expect(
      identitiesService.bulkCreateIdentities([WALLET], {
        connection: {} as any
      })
    ).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
  });
});
