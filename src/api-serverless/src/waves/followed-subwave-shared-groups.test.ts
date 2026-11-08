import { SqlExecutor } from '@/sql-executor';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { WavesApiDb } from './waves.api.db';

function fakeRepo(collation: 'match' | 'mismatch') {
  const statements: { sql: string; params: Record<string, unknown> }[] = [];
  const execute = jest.fn(
    async (sql: string, params: Record<string, unknown> = {}) => {
      if (sql.includes('information_schema.columns')) {
        const name =
          collation === 'match' ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_unicode_ci';
        return (params.tables as string[]).map(() => ({
          collation_name: name
        }));
      }
      statements.push({ sql, params });
      return [];
    }
  );
  const repo = new WavesApiDb(() => ({ execute }) as unknown as SqlExecutor);
  return { repo, statements, execute };
}

const groups = Array.from({ length: 300 }, (_, i) => `group-${i}`);
const read = (repo: WavesApiDb, eligibleGroups: string[]) =>
  repo.findFollowedSubwaveOverviewContextsByParentWaveId(
    {
      identityId: 'viewer',
      parentWaveIds: ['parent-1', 'parent-2'],
      eligibleGroups
    },
    {}
  );

describe('followed-subwave overview contexts with the shared viewer-group table', () => {
  beforeEach(() => resetViewerGroupsCteSupport());

  it('inlines the groups once per statement, as one JSON parameter', async () => {
    const { repo, statements } = fakeRepo('match');
    await read(repo, groups);
    // The activity aggregate and the unread aggregate.
    expect(statements).toHaveLength(2);
    for (const { sql, params } of statements) {
      expect(sql.match(/fs_viewer_groups as \(/g)).toHaveLength(1);
      expect(sql.match(/json_table\(/g)).toHaveLength(1);
      // Child and parent visibility.
      expect(
        sql.match(
          /select \/\*\+ NO_MERGE\(fs_viewer_groups\) SUBQUERY\(MATERIALIZATION\) \*\/ id from fs_viewer_groups/g
        )
      ).toHaveLength(2);
      expect(sql).not.toContain(':eligibleGroups');
      expect(JSON.parse(params.fs_viewer_groups_json as string)).toEqual(
        groups
      );
    }
  });

  it('keeps the inlined list while the collations differ', async () => {
    const { repo, statements } = fakeRepo('mismatch');
    await read(repo, groups);
    for (const { sql } of statements) {
      expect(sql).not.toContain('fs_viewer_groups');
      expect(sql).toContain(':eligibleGroups');
    }
  });

  it('needs neither the table nor the check without groups', async () => {
    const { repo, statements, execute } = fakeRepo('match');
    await read(repo, []);
    for (const { sql } of statements)
      expect(sql).not.toContain('fs_viewer_groups');
    expect(
      execute.mock.calls.some(([sql]) => sql.includes('information_schema'))
    ).toBe(false);
  });
});
