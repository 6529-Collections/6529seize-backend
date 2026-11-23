import {
  ownedColumnProblems,
  unstableColumns
} from '@/rebuild/run/owned-columns';
import { TableEntry } from '@/rebuild/manifest.types';
import { ColumnInfo } from '@/rebuild/stack/mysql-admin';

function column(name: string, over: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    dataType: 'int',
    nullable: true,
    hasDefault: false,
    extra: '',
    ...over
  };
}

const COLUMNS = [
  column('id', { nullable: false }),
  column('name', { dataType: 'varchar' }),
  column('tdh'),
  column('created_at', { dataType: 'datetime', nullable: false }),
  column('total', { extra: 'STORED GENERATED' }),
  column('born', { dataType: 'datetime', nullable: false })
];

function check(
  owned: string[],
  over: { primaryKey?: string[]; volatile?: string[] } = {}
): string[] {
  return ownedColumnProblems({
    table: 'ident',
    owners: [{ step: 'a.owner', columns: owned }],
    columns: COLUMNS,
    primaryKey: over.primaryKey ?? ['id'],
    volatile: over.volatile ?? []
  });
}

describe('ownedColumnProblems', () => {
  it('lets owners of present, resettable columns outside the key run', () => {
    expect(check(['tdh', 'name'])).toEqual([]);
  });

  it('refuses a table without a primary key', () => {
    expect(check(['tdh'], { primaryKey: [] })).toEqual([
      'ident has column owners but no primary key: the run carries owned columns across a rebuild by the key'
    ]);
  });

  it('refuses a table whose primary key has a volatile column', () => {
    expect(
      check(['tdh'], {
        primaryKey: ['id', 'created_at'],
        volatile: ['created_at']
      })
    ).toEqual([
      'ident has column owners, but its primary key has volatile or exempt created_at: the run carries owned columns across a rebuild by the key'
    ]);
  });

  it('counts exempt columns with volatile ones, as the comparison leaves both out', () => {
    expect(
      unstableColumns({
        class: 'INDEX',
        volatileColumns: [{ column: 'created_at', reason: 'clock' }],
        exemptColumns: [{ column: 'seen', reason: 'random' }]
      } as unknown as TableEntry)
    ).toEqual(['created_at', 'seen']);
    expect(unstableColumns(undefined)).toEqual([]);
    expect(
      check(['tdh'], { primaryKey: ['id', 'seen'], volatile: ['seen'] })
    ).toEqual([
      'ident has column owners, but its primary key has volatile or exempt seen: the run carries owned columns across a rebuild by the key'
    ]);
  });

  it('refuses an owned column that is missing, in the key, generated or not resettable', () => {
    expect(check(['gone', 'id', 'total', 'born'])).toEqual([
      "column owner a.owner owns ident.gone, which the schema doesn't have",
      'column owner a.owner owns ident.id, part of the primary key: only the row writer writes keys',
      'column owner a.owner owns ident.total, a generated column: MySQL writes it',
      "column owner a.owner owns ident.born, a NOT NULL datetime with no default: the run can't reset it for its owner"
    ]);
  });
});
