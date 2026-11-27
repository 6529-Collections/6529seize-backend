import {
  ColumnInfo,
  resetValue,
  writtenByMysql
} from '@/rebuild/stack/mysql-admin';

function column(over: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name: 'c',
    dataType: 'int',
    nullable: false,
    hasDefault: false,
    extra: '',
    ...over
  };
}

describe('resetValue', () => {
  it('takes the default first, then NULL', () => {
    expect(resetValue(column({ hasDefault: true, nullable: true }))).toBe(
      'DEFAULT'
    );
    expect(resetValue(column({ nullable: true }))).toBe('NULL');
  });

  it("gives a NOT NULL column without a default its type's zero", () => {
    expect(resetValue(column({ dataType: 'bigint' }))).toBe('0');
    expect(resetValue(column({ dataType: 'decimal' }))).toBe('0');
    expect(resetValue(column({ dataType: 'varchar' }))).toBe("''");
    expect(resetValue(column({ dataType: 'longblob' }))).toBe("''");
  });

  it('has none for a NOT NULL column of another type without a default', () => {
    expect(resetValue(column({ dataType: 'datetime' }))).toBeNull();
    expect(resetValue(column({ dataType: 'json' }))).toBeNull();
    expect(resetValue(column({ dataType: 'enum' }))).toBeNull();
  });
});

describe('writtenByMysql', () => {
  it('is true for an on update column and for generated ones', () => {
    expect(
      writtenByMysql(
        column({ extra: 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP' })
      )
    ).toBe(true);
    expect(writtenByMysql(column({ extra: 'VIRTUAL GENERATED' }))).toBe(true);
    expect(writtenByMysql(column({ extra: 'STORED GENERATED' }))).toBe(true);
  });

  it('is false for a default expression alone, auto_increment and none', () => {
    expect(writtenByMysql(column({ extra: 'DEFAULT_GENERATED' }))).toBe(false);
    expect(writtenByMysql(column({ extra: 'auto_increment' }))).toBe(false);
    expect(writtenByMysql(column())).toBe(false);
  });
});
