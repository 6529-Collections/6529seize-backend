import { XTdhIdentitySnapshotDb } from './xtdh-identity-snapshot.db';
import { SqlExecutor } from '@/sql-executor';

const connection = { connection: null };
const rows = [{ consolidation_key: 'key', profile_id: 'profile' }];
function fixture(current = rows) {
  const execute = jest
    .fn()
    .mockResolvedValueOnce(current)
    .mockResolvedValueOnce(rows)
    .mockResolvedValue([]);
  const bulkInsert = jest.fn();
  const bulkUpsert = jest.fn();
  const db = { execute, bulkInsert, bulkUpsert } as unknown as SqlExecutor;
  return {
    repo: new XTdhIdentitySnapshotDb(() => db),
    execute,
    bulkInsert,
    bulkUpsert
  };
}

it('publishes all xTDH fields together using current REP and TDH', async () => {
  const { repo, execute } = fixture();
  await repo.publish({ connection });
  expect(execute.mock.calls[0][0]).toContain('FOR UPDATE');
  expect(execute.mock.calls[2][0]).toContain(
    'i.level_raw = i.rep + i.tdh + w.xtdh'
  );
  expect(execute.mock.calls[2][0]).not.toMatch(/SET i\.rep|i\.tdh =/);
  expect(execute.mock.calls[2][2]).toEqual({ wrappedConnection: connection });
});

it.each(
  [
    [],
    [{ consolidation_key: 'changed', profile_id: 'profile' }],
    [{ consolidation_key: 'key', profile_id: 'changed' }]
  ].map((current) => ({ current }))
)(
  'rejects changed identity membership before publishing',
  async ({ current }) => {
    const { repo, execute } = fixture(current);
    await expect(repo.publish({ connection })).rejects.toThrow(
      'Identity consolidation changed'
    );
    expect(execute).toHaveBeenCalledTimes(2);
  }
);

it('prepares private working data using a nonlocking SELECT', async () => {
  const { repo, execute, bulkInsert } = fixture();
  execute
    .mockReset()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(rows);
  await repo.prepare({ connection });
  expect(execute.mock.calls[1][0]).toContain('CREATE TEMPORARY TABLE');
  expect(execute.mock.calls[2][0]).toBe(
    'SELECT consolidation_key, profile_id FROM identities'
  );
  expect(bulkInsert).toHaveBeenCalledWith(
    'xtdh_identity_work',
    [expect.objectContaining({ ...rows[0], xtdh: 0, produced_xtdh: 0 })],
    [
      'consolidation_key',
      'profile_id',
      'produced_xtdh',
      'granted_xtdh',
      'xtdh',
      'xtdh_rate'
    ],
    { connection }
  );
});

it('leaves identities created after the snapshot outside this publication', async () => {
  const { repo, execute } = fixture([
    ...rows,
    { consolidation_key: 'new', profile_id: 'new' }
  ]);
  await repo.publish({ connection });
  expect(execute.mock.calls[2][0]).toContain('JOIN xtdh_identity_work');
});
