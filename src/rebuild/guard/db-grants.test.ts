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
      "GRANT SELECT, INSERT, UPDATE, DELETE ON `rebuild`.`team` TO 'rb_1'@'%'",
      "GRANT SELECT ON `rebuild`.`nfts` TO 'rb_1'@'%'"
    ]);
    expect(dropUserStatement('rb_1')).toBe("DROP USER IF EXISTS 'rb_1'@'%'");
  });

  it('escapes table names', () => {
    const [, , , grant] = stepGrantStatements({
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
