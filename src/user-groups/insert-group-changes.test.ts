import 'reflect-metadata';
import { PROFILE_GROUP_CHANGES } from '@/constants';
import { BadRequestException } from '@/exceptions';
import { identitiesDb } from '@/identities/identities.db';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';

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

  it('writes on the connection it is given', async () => {
    const { db, execute } = buildDb();
    const connection = { connection: 'tx' } as ConnectionWrapper<any>;
    await db.insertGroupChanges(['profile-1'], connection);
    expect(execute).toHaveBeenCalledWith(expect.any(String), undefined, {
      wrappedConnection: connection
    });
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

describe('UserGroupsDb insertGroupEntriesAndGetGroupIds', () => {
  afterEach(() => jest.restoreAllMocks());

  it("writes the change records on the group's connection, so a later chunk refused rolls them back", async () => {
    const { db, execute } = buildDb();
    const connection = { connection: 'group' } as ConnectionWrapper<any>;
    // 100 addresses that get a profile id, then, in the next chunk, one an
    // identity of several wallets without a profile id holds.
    const addresses = Array.from(
      { length: 101 },
      (_, i) => `0x${i.toString(16).padStart(40, '0')}`
    );
    const refused = addresses[100];
    jest
      .spyOn(identitiesDb, 'getEverythingRelatedToIdentitiesByAddresses')
      .mockResolvedValue({});
    jest
      .spyOn(identitiesDb, 'insertIdentitiesOnAddressesOnly')
      .mockImplementation(
        async (wanted) =>
          new Map(
            wanted
              .filter((a) => a !== refused)
              .map((a) => [a, `profile-${parseInt(a, 16)}`])
          )
      );
    await expect(
      db.insertGroupEntriesAndGetGroupIds(addresses, connection)
    ).rejects.toThrow(BadRequestException);
    const changes = execute.mock.calls.filter(([sql]) =>
      String(sql).includes(PROFILE_GROUP_CHANGES)
    );
    expect(changes).toHaveLength(1);
    expect(countInsertedRows([changes[0][0]])).toBe(100);
    expect(changes[0][2]).toEqual({ wrappedConnection: connection });
  });
});
