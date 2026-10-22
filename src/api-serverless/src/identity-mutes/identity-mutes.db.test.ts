import { IdentityMutesDb } from './identity-mutes.db';

function createRepo() {
  const db = {
    execute: jest.fn(),
    oneOrNull: jest.fn(),
    bulkInsert: jest.fn().mockResolvedValue(undefined)
  };
  return {
    db,
    repo: new IdentityMutesDb(() => db as any)
  };
}

describe('IdentityMutesDb', () => {
  it('returns whether an identity is muted by another identity', async () => {
    const { db, repo } = createRepo();
    const pair = {
      muter_id: 'muter-1',
      muted_identity_id: 'muted-1'
    };
    db.oneOrNull.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce(null);

    await expect(repo.isIdentityMuted(pair)).resolves.toBe(true);
    await expect(repo.isIdentityMuted(pair)).resolves.toBe(false);

    expect(db.oneOrNull).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('from identity_mutes'),
      pair,
      undefined
    );
    expect(db.oneOrNull).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('from identity_mutes'),
      pair,
      undefined
    );
  });

  it('returns matching muted identity ids', async () => {
    const { db, repo } = createRepo();
    db.execute.mockResolvedValue([
      { muted_identity_id: 'muted-1' },
      { muted_identity_id: 'muted-2' }
    ]);

    await expect(
      repo.findMutedIdentityIds({
        muterId: 'muter-1',
        mutedIdentityIds: ['muted-1', 'muted-1', 'muted-2']
      })
    ).resolves.toEqual(['muted-1', 'muted-2']);

    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('from identity_mutes'),
      {
        muterId: 'muter-1',
        mutedIdentityIds: ['muted-1', 'muted-2']
      },
      undefined
    );
  });

  it('filters notification rows for muted actor-recipient pairs', async () => {
    const { db, repo } = createRepo();
    db.execute.mockResolvedValueOnce([
      { muter_id: 'recipient-1', muted_identity_id: 'actor-1' }
    ]);

    const rows = [
      {
        identity_id: 'recipient-1',
        additional_identity_id: 'actor-1',
        id: 1
      },
      {
        identity_id: 'recipient-1',
        additional_identity_id: 'actor-2',
        id: 2
      },
      {
        identity_id: 'recipient-2',
        additional_identity_id: 'actor-1',
        id: 3
      },
      {
        identity_id: 'recipient-2',
        additional_identity_id: null,
        id: 4
      }
    ];

    await expect(repo.filterMutedNotificationRows(rows)).resolves.toEqual([
      rows[1],
      rows[2],
      rows[3]
    ]);
    expect(db.execute).toHaveBeenCalledTimes(1);
  });
});

it.each(['muteIdentity', 'unmuteIdentity'] as const)(
  'captures %s and advances unread versions without checking online recipients',
  async (method) => {
    const { db, repo } = createRepo();
    const connection = { connection: {} };
    db.execute.mockImplementation(async (sql: string) =>
      sql.includes('select r.wave_id') ? [{ wave_id: 'wave-1' }] : []
    );
    await repo[method](
      { muter_id: 'muter-1', muted_identity_id: 'author-1' },
      { connection }
    );
    for (const fragment of [
      method === 'muteIdentity'
        ? 'insert into identity_mutes'
        : 'delete from identity_mutes',
      'set unread_state_version = unread_state_version + 1'
    ]) {
      expect(db.execute).toHaveBeenCalledWith(
        expect.stringContaining(fragment),
        expect.anything(),
        { wrappedConnection: connection }
      );
    }
    expect(db.bulkInsert).toHaveBeenCalledWith(
      'websocket_outbox',
      [
        expect.objectContaining({
          event: JSON.stringify({
            type: 'dm',
            profileIds: ['muter-1'],
            waveId: 'wave-1',
            deliveryCapability: 'durable_updates_v1'
          })
        })
      ],
      expect.any(Array),
      { connection },
      { connection }
    );
  }
);

const originalNodeEnvironment = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  process.env.NODE_ENV = originalNodeEnvironment;
});

it.each(['muteIdentity', 'unmuteIdentity'] as const)(
  'captures every affected offline wave for multiple pairs during %s',
  async (method) => {
    const { db, repo } = createRepo();
    const connection = { connection: {} };
    const pairs = [
      { muter_id: 'reader-a', muted_identity_id: 'author-a' },
      { muter_id: 'reader-b', muted_identity_id: 'author-b' }
    ];
    db.execute.mockImplementation(async (sql: string, params) =>
      sql.includes('select r.wave_id')
        ? [
            { wave_id: `${params.readerId}-one` },
            { wave_id: `${params.readerId}-two` }
          ]
        : []
    );
    for (const pair of pairs) {
      await repo[method](pair, { connection });
    }
    for (const pair of pairs) {
      expect(db.execute).toHaveBeenCalledWith(
        expect.stringContaining(
          'set unread_state_version = unread_state_version + 1'
        ),
        {
          readerId: pair.muter_id,
          waveIds: [`${pair.muter_id}-one`, `${pair.muter_id}-two`]
        },
        { wrappedConnection: connection }
      );
    }
    const captured = db.bulkInsert.mock.calls.flatMap((call) =>
      call[1].map((row: { event: string }) => JSON.parse(row.event))
    );
    expect(captured).toEqual(
      pairs.flatMap((pair) =>
        ['one', 'two'].map((suffix) => ({
          type: 'dm',
          profileIds: [pair.muter_id],
          waveId: `${pair.muter_id}-${suffix}`,
          deliveryCapability: 'durable_updates_v1'
        }))
      )
    );
    const scopeQueries = db.execute.mock.calls.filter(([sql]) =>
      sql.includes('select r.wave_id')
    );
    expect(scopeQueries).toHaveLength(2);
    for (const [sql, , options] of scopeQueries) {
      expect(sql).toContain('w.is_direct_message = true');
      expect(sql).not.toContain('ws_connections');
      expect(options.wrappedConnection).toBe(connection);
    }
    for (const call of db.bulkInsert.mock.calls)
      expect(call[3].connection).toBe(connection);
  }
);
