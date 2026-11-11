import { ProfileProxiesDb } from './profile-proxies.db';

function createDb(proxiesByColumn: Record<string, string[]>) {
  const execute = jest.fn(async (sql: string, ..._rest: unknown[]) => {
    const column = /where (target_id|created_by) = :profileId for update/.exec(
      sql
    )?.[1];
    return column ? proxiesByColumn[column].map((id) => ({ id })) : [];
  });
  const db = new ProfileProxiesDb(() => ({ execute }) as any);
  return { db, execute };
}

describe('ProfileProxiesDb.deleteAllProxiesAndActionsForProfile', () => {
  const connection = { connection: 'tx' } as any;

  it('only reads both indexed sides when the profile has no proxies', async () => {
    const { db, execute } = createDb({ target_id: [], created_by: [] });

    await db.deleteAllProxiesAndActionsForProfile('no-handle', connection);

    expect(execute.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('where target_id = :profileId for update'),
      expect.stringContaining('where created_by = :profileId for update')
    ]);
    for (const [sql] of execute.mock.calls) expect(sql).not.toMatch(/ or /i);
    for (const call of execute.mock.calls)
      expect(call[2]).toEqual({ wrappedConnection: connection });
  });

  it('deletes balances, actions and proxies of both sides once each, by proxy id', async () => {
    const { db, execute } = createDb({
      target_id: ['to-source', 'self'],
      created_by: ['by-source', 'self']
    });

    await db.deleteAllProxiesAndActionsForProfile('source', connection);

    const deletes = execute.mock.calls.slice(2);
    expect(deletes.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^delete balances from/),
      expect.stringMatching(
        /^delete from profile_proxy_actions where proxy_id in/
      ),
      expect.stringMatching(/^delete from profile_proxies where id in/)
    ]);
    for (const [, params] of deletes)
      expect(params).toEqual({ proxy_ids: ['to-source', 'self', 'by-source'] });
  });
});
