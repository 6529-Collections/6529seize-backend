import 'reflect-metadata';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { SqlExecutor } from '@/sql-executor';

function buildDb() {
  const execute = jest.fn().mockResolvedValue([]);
  const db = new UserGroupsDb(() => ({ execute }) as unknown as SqlExecutor);
  return { db, execute };
}

function countInsertedRows(statements: string[]): number {
  return statements.join(' ').match(/\('profile-\d+'/g)?.length ?? 0;
}

describe('UserGroupsDb insertGroupChanges', () => {
  it('does nothing for an empty profile id list', async () => {
    const { db, execute } = buildDb();
    await db.insertGroupChanges([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('inserts small lists in a single statement', async () => {
    const { db, execute } = buildDb();
    await db.insertGroupChanges(['profile-1', 'profile-2']);
    expect(execute).toHaveBeenCalledTimes(1);
    const sql = execute.mock.calls[0][0] as string;
    expect(sql).toContain("('profile-1'");
    expect(sql).toContain("('profile-2'");
  });

  it('chunks large lists into multiple statements of at most 1000 rows', async () => {
    const { db, execute } = buildDb();
    const profileIds = Array.from(
      { length: 2500 },
      (_, index) => `profile-${index}`
    );

    await db.insertGroupChanges(profileIds);

    expect(execute).toHaveBeenCalledTimes(3);
    const statements = execute.mock.calls.map((call) => call[0] as string);
    expect(statements[0]).toContain("('profile-0'");
    expect(statements[0]).toContain("('profile-999'");
    expect(statements[0]).not.toContain("('profile-1000'");
    expect(statements[1]).toContain("('profile-1000'");
    expect(statements[1]).toContain("('profile-1999'");
    expect(statements[2]).toContain("('profile-2000'");
    expect(statements[2]).toContain("('profile-2499'");
    expect(countInsertedRows(statements)).toBe(2500);
  });
});
