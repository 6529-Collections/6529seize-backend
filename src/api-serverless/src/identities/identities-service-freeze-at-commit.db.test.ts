import 'reflect-metadata';
import { IDENTITIES_TABLE, PROFILES_TABLE } from '@/constants';
import {
  IDENTITY_FROZEN_NOMINATION_MESSAGE,
  IdentityFrozenException
} from '@/identity-freeze/identity-freeze';
import { profilesDb } from '@/profiles/profiles.db';
import { profilesService } from '@/profiles/profiles.service';
import { sqlExecutor } from '@/sql-executor';
import { freezeClock, settle } from '@/tests/fixtures/freeze-at-commit.fixture';

async function rowsFor(wallet: string) {
  const identities = await sqlExecutor.execute<{ profile_id: string }>(
    `select profile_id from ${IDENTITIES_TABLE} where primary_address = :wallet`,
    { wallet }
  );
  const profiles = await sqlExecutor.execute<{ external_id: string }>(
    `select external_id from ${PROFILES_TABLE} where primary_wallet = :wallet`,
    { wallet }
  );
  return { identities, profiles };
}

/** A drop's transaction that nominates `wallet`, as the drop write does. */
function nominate(wallet: string) {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    profilesService.makeSureProfilesAreCreatedAndGetProfileIdsByAddresses(
      [wallet],
      { connection }
    )
  );
}

describe('a drop that nominates a wallet with no identity, on the database', () => {
  let clock: ReturnType<typeof freezeClock>;
  beforeEach(() => {
    clock = freezeClock();
  });
  afterEach(() => {
    clock.restore();
    jest.restoreAllMocks();
  });

  it('leaves no identity or profile behind when T passes before its COMMIT', async () => {
    const wallet = '0x00000000000000000000000000000000000f2e01';
    const insertProfiles = profilesDb.bulkInsertProfiles.bind(profilesDb);
    jest
      .spyOn(profilesDb, 'bulkInsertProfiles')
      .mockImplementation(async (...args) => {
        await insertProfiles(...args);
        // The profile row is written; T passes before the drop commits.
        clock.pass();
      });

    const { error } = await settle(nominate(wallet));

    expect(error).toBeInstanceOf(IdentityFrozenException);
    expect((error as IdentityFrozenException).getStatusCode()).toBe(423);
    expect((error as Error).message).toBe(IDENTITY_FROZEN_NOMINATION_MESSAGE);
    expect(await rowsFor(wallet)).toEqual({ identities: [], profiles: [] });
  });

  it('keeps the identity and profile when the drop commits before T', async () => {
    const wallet = '0x00000000000000000000000000000000000f2e02';

    const ids = await nominate(wallet);

    const rows = await rowsFor(wallet);
    expect(rows.identities).toHaveLength(1);
    expect(rows.profiles).toEqual([{ external_id: ids[wallet] }]);
  });
});
