import { IDENTITIES_TABLE, PROFILES_TABLE } from '@/constants';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { IdentitiesDb } from './identities.db';

const unchanged = {
  external_id: 'a-unchanged-profile',
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
const seededIds = [unchanged, changed, orphan].map(
  (profile) => profile.external_id
);

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
  let repo: IdentitiesDb;

  async function clearTables(): Promise<void> {
    for (const { table } of seeds) {
      await sqlExecutor.execute(`DELETE FROM ${table}`);
    }
  }

  beforeEach(async () => {
    repo = new IdentitiesDb(() => sqlExecutor);
    await clearTables();
    for (const { table, rows } of seeds) {
      await sqlExecutor.bulkInsert(table, rows, Object.keys(rows[0]));
    }
  });
  afterEach(clearTables);

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

  async function seedPageProfiles() {
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
    for (const { table, rows } of [
      withProfiles(profiles),
      withIdentities(identities)
    ]) {
      await sqlExecutor.bulkInsert(table, rows, Object.keys(rows[0]));
    }
    return profiles;
  }

  it('leaves unchanged profiles available for posting before the consolidation transaction commits', async () => {
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.syncProfileAddressesFromIdentitiesToProfiles(
        seededIds,
        connection
      );
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
      await repo.syncProfileAddressesFromIdentitiesToProfiles(
        seededIds,
        connection
      );
      await lockUnchangedProfile(connection);
    });
  });

  it('rolls address changes back with the consolidation transaction', async () => {
    const failure = new Error('Consolidation failed');
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        await repo.syncProfileAddressesFromIdentitiesToProfiles(
          seededIds,
          connection
        );
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(await walletFor(changed.external_id)).toBe(changed.primary_wallet);
  });

  it('still synchronizes the profile when its handle is reassigned after discovery', async () => {
    const execute = sqlExecutor.execute.bind(sqlExecutor);
    let handleReassigned = false;
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
        handleReassigned = true;
        return rows;
      });
    try {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        repo.syncProfileAddressesFromIdentitiesToProfiles(seededIds, connection)
      );
    } finally {
      discovery.mockRestore();
    }
    expect(handleReassigned).toBe(true);
    expect(await walletFor(changed.external_id)).toBe(replacementWallet);
    expect(await walletFor(orphan.external_id)).toBe(orphan.primary_wallet);
  });

  it('synchronizes all changed profiles across page boundaries without locking unchanged profiles', async () => {
    const profiles = await seedPageProfiles();

    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await repo.syncProfileAddressesFromIdentitiesToProfiles(
        [...seededIds, ...profiles.map((profile) => profile.external_id)],
        connection
      );
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

  it('preserves an atomic primary-address change committed behind the page being synchronized', async () => {
    const profiles = await seedPageProfiles();
    const execute = sqlExecutor.execute.bind(sqlExecutor);
    let discoveries = 0;
    let changedBehindCursor = false;
    const interleaving = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql, params, options) => {
        if (Array.isArray(params?.profileIds)) discoveries++;
        if (!changedBehindCursor && discoveries === 2) {
          // The second page: the first one, with this profile, is done.
          expect(params?.profileIds[0] > unchanged.external_id).toBe(true);
          changedBehindCursor = true;
          await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            repo.updatePrimaryAddress(
              {
                profileId: unchanged.external_id,
                primaryAddress: 'concurrent-wallet'
              },
              connection
            )
          );
        }
        return execute(sql, params, options);
      });
    try {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        repo.syncProfileAddressesFromIdentitiesToProfiles(
          [...seededIds, ...profiles.map((profile) => profile.external_id)],
          connection
        )
      );
    } finally {
      interleaving.mockRestore();
    }
    expect(changedBehindCursor).toBe(true);
    expect(await walletFor(unchanged.external_id)).toBe('concurrent-wallet');
    const identity = await sqlExecutor.oneOrNull<{ primary_address: string }>(
      `SELECT primary_address FROM ${IDENTITIES_TABLE} WHERE profile_id=:id`,
      { id: unchanged.external_id }
    );
    expect(identity?.primary_address).toBe('concurrent-wallet');
  });

  it('synchronizes every profile row sharing one nonunique external ID', async () => {
    const alias = aProfile({ ...changed, handle: 'changed-alias' });
    await sqlExecutor.bulkInsert(PROFILES_TABLE, [alias], Object.keys(alias));

    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      repo.syncProfileAddressesFromIdentitiesToProfiles(seededIds, connection)
    );
    const rows = await sqlExecutor.execute<{ primary_wallet: string }>(
      `SELECT primary_wallet FROM ${PROFILES_TABLE} WHERE external_id=:id`,
      { id: changed.external_id }
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.primary_wallet === replacementWallet)).toBe(
      true
    );
  });

  it('never reads, locks or changes a profile it is not given', async () => {
    // `changed` differs from its identity, but the caller did not touch it.
    const statements: { sql: string; params: unknown }[] = [];
    let recording = true;
    const execute = sqlExecutor.execute.bind(sqlExecutor);
    const spy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation(async (sql, params, options) => {
        if (recording) statements.push({ sql, params });
        return execute(sql, params, options);
      });
    try {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await repo.syncProfileAddressesFromIdentitiesToProfiles(
            [unchanged.external_id, orphan.external_id],
            connection
          );
          recording = false;
          // Another transaction can take the untouched profile's row at once.
          await sqlExecutor.executeNativeQueriesInTransaction((other) =>
            sqlExecutor.execute(
              `SELECT external_id FROM ${PROFILES_TABLE} WHERE external_id=:id FOR UPDATE NOWAIT`,
              { id: changed.external_id },
              { wrappedConnection: other }
            )
          );
        }
      );
    } finally {
      spy.mockRestore();
    }

    const syncStatements = statements.filter(({ sql }) =>
      sql.includes('primary_wallet')
    );
    expect(syncStatements).toHaveLength(1);
    expect(syncStatements[0].params).toEqual({
      profileIds: [unchanged.external_id, orphan.external_id]
    });
    expect(JSON.stringify(statements)).not.toContain(
      JSON.stringify(changed.external_id)
    );
    expect(await walletFor(changed.external_id)).toBe(changed.primary_wallet);
  });
});
