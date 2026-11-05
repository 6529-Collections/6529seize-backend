import { IDENTITIES_TABLE, PROFILES_TABLE } from '@/constants';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
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

  async function lockUnchangedProfile(
    outerConnection: ConnectionWrapper<unknown>
  ): Promise<void> {
    const outer = await sqlExecutor.oneOrNull<{ id: number }>(
      'SELECT CONNECTION_ID() AS id',
      undefined,
      { wrappedConnection: outerConnection }
    );
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const inner = await sqlExecutor.oneOrNull<{ id: number }>(
        'SELECT CONNECTION_ID() AS id',
        undefined,
        { wrappedConnection: connection }
      );
      expect(inner?.id).not.toBe(outer?.id);
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
      await lockUnchangedProfile(connection);
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
      await lockUnchangedProfile(connection);
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

  it('still synchronizes the profile when its handle is reassigned after discovery', async () => {
    const execute = sqlExecutor.execute.bind(sqlExecutor);
    const discovery = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementationOnce(async (sql, params, options) => {
        const rows = await execute(sql, params, options);
        await execute(
          `UPDATE ${PROFILES_TABLE} SET normalised_handle='renamed', handle='Renamed' WHERE external_id=:id`,
          { id: changed.external_id }
        );
        await execute(
          `UPDATE ${PROFILES_TABLE} SET normalised_handle=:handle, handle=:handle WHERE external_id=:id`,
          { id: orphan.external_id, handle: changed.handle }
        );
        return rows;
      });
    try {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        repo.syncProfileAddressesFromIdentitiesToProfiles(connection)
      );
    } finally {
      discovery.mockRestore();
    }
    expect(await walletFor(changed.external_id)).toBe(replacementWallet);
    expect(await walletFor(orphan.external_id)).toBe(orphan.primary_wallet);
  });

  it('synchronizes all changed profiles across page boundaries without locking unchanged profiles', async () => {
    const profiles = Array.from({ length: 101 }, (_, index) =>
      aProfile({
        external_id: `page-profile-${String(index).padStart(3, '0')}`,
        handle: `page-${index}`,
        primary_wallet: `old-wallet-${index}`
      })
    );
    const identities = profiles.map((profile) =>
      anIdentity(
        {},
        {
          profile_id: profile.external_id,
          consolidation_key: profile.external_id,
          primary_address: `new-${profile.external_id}`,
          handle: profile.handle
        }
      )
    );
    const profileSeed = withProfiles(profiles);
    const identitySeed = withIdentities(identities);
    for (const { table, rows } of [profileSeed, identitySeed]) {
      await sqlExecutor.bulkInsert(table, rows, Object.keys(rows[0]));
    }

    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.syncProfileAddressesFromIdentitiesToProfiles(connection);
      await lockUnchangedProfile(connection);
    });
    const updated = await sqlExecutor.execute<{ external_id: string }>(
      `SELECT p.external_id FROM ${PROFILES_TABLE} p
       JOIN ${IDENTITIES_TABLE} i ON i.profile_id=p.external_id
       WHERE p.external_id IN (:ids) AND p.primary_wallet=i.primary_address`,
      {
        ids: profiles.map((profile) => profile.external_id)
      }
    );
    expect(updated).toHaveLength(profiles.length);
    expect(await walletFor(changed.external_id)).toBe(replacementWallet);
    expect(await walletFor(unchanged.external_id)).toBe(
      unchanged.primary_wallet
    );
    expect(await walletFor(orphan.external_id)).toBe(orphan.primary_wallet);
  });
});
