import { rowKeyProblems } from '@/rebuild/run/row-keys';
import { ColumnInfo } from '@/rebuild/stack/mysql-admin';

const column = (name: string, nullable = false): ColumnInfo => ({
  name,
  dataType: 'varchar',
  nullable,
  hasDefault: false,
  extra: ''
});

describe('declared row keys and scoped volatile columns against the schema', () => {
  // waves: serial_no is the auto-increment primary key, id is UNIQUE.
  const waves = {
    table: 'waves',
    primaryKey: ['serial_no'],
    uniqueKeys: [['serial_no'], ['id']],
    columns: [column('serial_no'), column('id'), column('name', true)],
    scoped: [] as { column: string }[],
    unstable: [] as string[]
  };

  it('takes a rowKey that is exactly a UNIQUE index of NOT NULL columns', () => {
    expect(rowKeyProblems({ ...waves, rowKey: ['id'] })).toEqual({
      problems: [],
      notes: []
    });
    // Rows come back under the schema's spelling: another case would
    // key every row by nothing, so it is refused, naming the spelling.
    expect(rowKeyProblems({ ...waves, rowKey: ['ID'] }).problems).toEqual([
      "waves's rowKey names ID, which the schema spells id"
    ]);
  });

  it('refuses a rowKey the schema lacks, no UNIQUE index has exactly, or that may be NULL', () => {
    expect(
      rowKeyProblems({ ...waves, rowKey: ['nope', 'Name'] }).problems
    ).toEqual([
      "waves's rowKey names nope, which the schema doesn't have; Name, which the schema spells name"
    ]);
    // A UNIQUE index on more columns doesn't make each part unique.
    expect(
      rowKeyProblems({
        ...waves,
        uniqueKeys: [['serial_no'], ['id', 'name']],
        rowKey: ['id']
      }).problems
    ).toEqual([
      "waves's rowKey (id) is no UNIQUE index of the table: two rows could share it"
    ]);
    expect(
      rowKeyProblems({
        ...waves,
        uniqueKeys: [['serial_no'], ['id', 'name']],
        rowKey: ['name', 'id']
      }).problems
    ).toEqual([
      "waves's rowKey holds name, which may be NULL: a UNIQUE index lets rows share a NULL"
    ]);
  });

  it('notes a rowKey that is the primary key', () => {
    expect(rowKeyProblems({ ...waves, rowKey: ['serial_no'] })).toEqual({
      problems: [],
      notes: ["waves's rowKey is its primary key: declaring it changes nothing"]
    });
  });

  it('needs a row key without a scoped volatile column', () => {
    const scoped = [{ column: 'serial_no' }];
    expect(
      rowKeyProblems({ ...waves, rowKey: ['id'], scoped }).problems
    ).toEqual([]);
    expect(rowKeyProblems({ ...waves, scoped }).problems).toEqual([
      "waves.serial_no is volatile where a condition holds, but it is in the table's primary key (declare a rowKey without it): rows are found by that key"
    ]);
    expect(
      rowKeyProblems({ ...waves, primaryKey: [], uniqueKeys: [], scoped })
        .problems
    ).toEqual([
      'waves.serial_no is volatile where a condition holds, but the table has no row key to tell which row it left out (declare a rowKey)'
    ]);
    expect(
      rowKeyProblems({ ...waves, rowKey: ['id'], scoped: [{ column: 'nope' }] })
        .problems
    ).toEqual([
      "waves.nope is volatile where a condition holds, but it names nope, which the schema doesn't have"
    ]);
    expect(
      rowKeyProblems({
        ...waves,
        rowKey: ['id'],
        scoped: [{ column: 'Serial_No' }]
      }).problems
    ).toEqual([
      'waves.Serial_No is volatile where a condition holds, but it names Serial_No, which the schema spells serial_no'
    ]);
  });

  it('needs a row key the comparison keeps on every row, for a scoped column', () => {
    // name is scoped; the primary key serial_no is volatile on every row.
    const scoped = [{ column: 'name' }];
    expect(
      rowKeyProblems({ ...waves, scoped, unstable: ['serial_no'] }).problems
    ).toEqual([
      "waves.name is volatile where a condition holds, but the table's primary key holds serial_no, which the comparison leaves out of every row (declare a rowKey without it): rows are found by that key"
    ]);
    expect(
      rowKeyProblems({
        ...waves,
        rowKey: ['id'],
        scoped,
        unstable: ['serial_no']
      }).problems
    ).toEqual([]);
  });
});
