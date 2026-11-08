import { SqlExecutor } from '@/sql-executor';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { IdentityNotificationsDb } from './identity-notifications.db';

type Collation = 'match' | 'mismatch';

function fakeRepo(collation: Collation) {
  const statements: { sql: string; params: Record<string, unknown> }[] = [];
  const record = async (sql: string, params: Record<string, unknown> = {}) => {
    if (sql.includes('information_schema.columns')) {
      const name =
        collation === 'match' ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_unicode_ci';
      return (params.tables as string[]).map(() => ({
        collation_name: name
      }));
    }
    statements.push({ sql, params });
    return [];
  };
  const db = {
    execute: jest.fn(record),
    oneOrNull: jest.fn(async (sql: string, params?: Record<string, unknown>) =>
      record(sql, params).then(() => ({ cnt: 0 }))
    )
  } as unknown as SqlExecutor;
  return { repo: new IdentityNotificationsDb(() => db), statements, db };
}

const groups = Array.from({ length: 300 }, (_, i) => `group-${i}`);
const read = (repo: IdentityNotificationsDb, eligible: string[]) =>
  Promise.all([
    repo.findNotifications({
      identity_id: 'viewer',
      id_less_than: null,
      limit: 20,
      eligible_group_ids: eligible,
      cause: null,
      cause_exclude: null,
      unread_only: false
    }),
    repo.countUnreadNotificationsForIdentity('viewer', eligible)
  ]);

describe('notification reads with the shared viewer-group table', () => {
  beforeEach(() => resetViewerGroupsCteSupport());

  it('inlines the groups once, as one JSON parameter, in both statements', async () => {
    const { repo, statements } = fakeRepo('match');
    await read(repo, groups);
    expect(statements).toHaveLength(2);
    for (const { sql, params } of statements) {
      expect(sql.match(/ntf_viewer_groups as \(/g)).toHaveLength(1);
      expect(sql.match(/json_table\(/g)).toHaveLength(1);
      // The notification's own visibility, its wave and the wave's parent.
      expect(
        sql.match(
          /select \/\*\+ NO_MERGE\(ntf_viewer_groups\) SUBQUERY\(MATERIALIZATION\) \*\/ id from ntf_viewer_groups/g
        )
      ).toHaveLength(3);
      expect(sql).not.toMatch(/:eligible_group_ids|:eligibleGroupIds/);
      expect(JSON.parse(params.ntf_viewer_groups_json as string)).toEqual(
        groups
      );
    }
  });

  it('keeps the inlined list while the collations differ', async () => {
    const { repo, statements } = fakeRepo('mismatch');
    await read(repo, groups);
    for (const { sql } of statements) {
      expect(sql).not.toContain('ntf_viewer_groups');
      expect(sql).toMatch(/:eligible_group_ids|:eligibleGroupIds/);
    }
  });

  it('needs neither the table nor the check without groups', async () => {
    const { repo, statements, db } = fakeRepo('match');
    await read(repo, []);
    for (const { sql } of statements)
      expect(sql).not.toContain('ntf_viewer_groups');
    expect(
      jest
        .mocked(db.execute)
        .mock.calls.some(([sql]) => sql.includes('information_schema'))
    ).toBe(false);
  });
});
