import * as fc from 'fast-check';
import {
  dropUserStatement,
  stepGrantStatements,
  stepUserName
} from '@/rebuild/guard/db-grants';

describe('step grants', () => {
  it('names a user per step within MySQL limits', () => {
    fc.assert(
      fc.property(fc.string(), (id) => {
        const name = stepUserName(id);
        expect(name).toMatch(/^rb_[0-9a-f]{16}$/);
        expect(name.length).toBeLessThanOrEqual(32);
        expect(stepUserName(id)).toBe(name);
      })
    );
    expect(stepUserName('a')).not.toBe(stepUserName('b'));
  });

  it('grants writes and reads on exactly the named tables', () => {
    expect(
      stepGrantStatements({
        user: 'rb_1',
        password: "p'w",
        database: 'rebuild',
        writes: ['team', 'team'],
        reads: ['nfts', 'team']
      })
    ).toEqual([
      "DROP USER IF EXISTS 'rb_1'@'%'",
      "CREATE USER 'rb_1'@'%' IDENTIFIED WITH mysql_native_password BY 'p\\'w'",
      "GRANT CREATE TEMPORARY TABLES ON `rebuild`.* TO 'rb_1'@'%'",
      "GRANT LOCK TABLES ON `rebuild`.* TO 'rb_1'@'%'",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `rebuild`.`team` TO 'rb_1'@'%'",
      "GRANT SELECT ON `rebuild`.`nfts` TO 'rb_1'@'%'"
    ]);
    expect(dropUserStatement('rb_1')).toBe("DROP USER IF EXISTS 'rb_1'@'%'");
  });

  it('holds a table with column owners to columns: the row writer and the owner', () => {
    const grants = stepGrantStatements({
      user: 'rb_1',
      password: 'x',
      database: 'db',
      writes: ['identities', 'team'],
      reads: ['identities'],
      columns: [
        {
          table: 'identities',
          insert: ['profile_id', 'handle'],
          update: ['profile_id', 'handle'],
          delete: true
        },
        { table: 'tdh', insert: [], update: ['tdh', 'xtdh'], delete: false }
      ]
    }).slice(4);
    expect(grants).toEqual([
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `db`.`team` TO 'rb_1'@'%'",
      "GRANT SELECT, DELETE ON `db`.`identities` TO 'rb_1'@'%'",
      "GRANT INSERT (`profile_id`, `handle`) ON `db`.`identities` TO 'rb_1'@'%'",
      "GRANT UPDATE (`profile_id`, `handle`) ON `db`.`identities` TO 'rb_1'@'%'",
      "GRANT SELECT ON `db`.`tdh` TO 'rb_1'@'%'",
      "GRANT UPDATE (`tdh`, `xtdh`) ON `db`.`tdh` TO 'rb_1'@'%'"
    ]);
  });

  it('escapes table names', () => {
    const [, , , , grant] = stepGrantStatements({
      user: 'rb_1',
      password: 'x',
      database: 'db',
      writes: ['we`ird'],
      reads: []
    });
    expect(grant).toBe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `db`.`we``ird` TO 'rb_1'@'%'"
    );
  });
});
