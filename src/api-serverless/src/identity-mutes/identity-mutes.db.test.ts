import { IdentityMutesDb } from './identity-mutes.db';

function createRepo() {
  const db = {
    execute: jest.fn(),
    oneOrNull: jest.fn()
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
      'set unread_state_version = unread_state_version + 1',
      'insert into websocket_outbox'
    ]) {
      expect(db.execute).toHaveBeenCalledWith(
        expect.stringContaining(fragment),
        expect.anything(),
        { wrappedConnection: connection }
      );
    }
  }
);

const originalNodeEnvironment = process.env.NODE_ENV;
beforeEach(() => {
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  process.env.NODE_ENV = originalNodeEnvironment;
});
