import { PROFILES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { IdentitiesDb } from './identities.db';

const unchanged = {
  external_id: 'unchanged-profile',
  handle: 'unchanged',
  primary_wallet: '0x1111'
};
const changed = {
  external_id: 'changed-profile',
  handle: 'changed',
  primary_wallet: '0x2222'
};
const replacementWallet = '0x3333';
const orphan = {
  external_id: 'orphan-profile',
  handle: 'orphan',
  primary_wallet: '0x4444'
};

describe('Profile address synchronization', () => {
  const seeds = [
    withProfiles([aProfile(unchanged), aProfile(changed), aProfile(orphan)]),
    withIdentities(
      [unchanged, { ...changed, primary_wallet: replacementWallet }].map(
        (profile) =>
          anIdentity(
            {},
            {
              profile_id: profile.external_id,
              consolidation_key: profile.primary_wallet,
              primary_address: profile.primary_wallet,
              handle: profile.handle
            }
          )
      )
    )
  ];

  async function clearTables(): Promise<void> {
    for (const { table } of seeds) {
      await sqlExecutor.execute(`DELETE FROM ${table}`);
    }
  }

  beforeEach(async () => {
    await clearTables();
    for (const { table, rows } of seeds) {
      await sqlExecutor.bulkInsert(table, rows, Object.keys(rows[0]));
    }
  });
  afterEach(clearTables);

  const repo = new IdentitiesDb(() => sqlExecutor);

  async function lockUnchangedProfile(): Promise<void> {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await sqlExecutor.execute(
        `SELECT external_id FROM ${PROFILES_TABLE} WHERE external_id=:id FOR UPDATE NOWAIT`,
        { id: unchanged.external_id },
        { wrappedConnection: connection }
      );
    });
  }

  async function walletFor(profileId: string): Promise<string | undefined> {
    const profile = await sqlExecutor.oneOrNull<{ primary_wallet: string }>(
      `SELECT primary_wallet FROM ${PROFILES_TABLE} WHERE external_id=:id`,
      { id: profileId }
    );
    return profile?.primary_wallet;
  }

  it('leaves unchanged profiles available for posting before the consolidation transaction commits', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.syncProfileAddressesFromIdentitiesToProfiles(connection);
      await lockUnchangedProfile();
    });

    expect(await walletFor(changed.external_id)).toBe(replacementWallet);
    expect(await walletFor(unchanged.external_id)).toBe(
      unchanged.primary_wallet
    );
    expect(await walletFor(orphan.external_id)).toBe(orphan.primary_wallet);
  });

  it('does not lock profiles when no addresses changed', async () => {
    await sqlExecutor.execute(
      `UPDATE ${PROFILES_TABLE} SET primary_wallet=:wallet WHERE external_id=:id`,
      { id: changed.external_id, wallet: replacementWallet }
    );

    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.syncProfileAddressesFromIdentitiesToProfiles(connection);
      await lockUnchangedProfile();
    });
  });

  it('rolls address changes back with the consolidation transaction', async () => {
    const failure = new Error('Consolidation failed');
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        await repo.syncProfileAddressesFromIdentitiesToProfiles(connection);
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(await walletFor(changed.external_id)).toBe(changed.primary_wallet);
  });
});
