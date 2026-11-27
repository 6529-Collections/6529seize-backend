import {
  columnKindOf,
  isGeneratedColumn,
  quoteIdentifier,
  selectExpression,
  writeExpression
} from './mint-log-columns';

describe('mint log columns', () => {
  it('keeps columns with an expression default and skips computed ones', () => {
    expect(isGeneratedColumn('DEFAULT_GENERATED')).toBe(false);
    expect(
      isGeneratedColumn('DEFAULT_GENERATED on update CURRENT_TIMESTAMP')
    ).toBe(false);
    expect(isGeneratedColumn('auto_increment')).toBe(false);
    expect(isGeneratedColumn(null)).toBe(false);
    expect(isGeneratedColumn('STORED GENERATED')).toBe(true);
    expect(isGeneratedColumn('VIRTUAL GENERATED')).toBe(true);
  });

  it('reads each type in a form that writes back to the same value', () => {
    const select = (dataType: string) =>
      selectExpression({ name: 'c', kind: columnKindOf(dataType) });
    expect(select('datetime')).toBe(
      "DATE_FORMAT(`c`, '%Y-%m-%d %H:%i:%s.%f') AS `c`"
    );
    expect(select('date')).toBe("DATE_FORMAT(`c`, '%Y-%m-%d') AS `c`");
    expect(select('timestamp')).toBe(
      'CAST(UNIX_TIMESTAMP(`c`) AS CHAR) AS `c`'
    );
    expect(select('json')).toBe('CAST(`c` AS CHAR) AS `c`');
    expect(select('BIGINT')).toBe('CAST(`c` AS CHAR) AS `c`');
    expect(select('decimal')).toBe('CAST(`c` AS CHAR) AS `c`');
    expect(select('tinyint')).toBe('CAST(`c` AS SIGNED) AS `c`');
    expect(select('varchar')).toBe('`c`');
    expect(select('double')).toBe('`c`');
  });

  it('writes a timestamp through FROM_UNIXTIME and other values as given', () => {
    expect(writeExpression({ name: 'c', kind: 'timestamp' }, 'p')).toBe(
      'FROM_UNIXTIME(:p)'
    );
    expect(writeExpression({ name: 'c', kind: 'datetime' }, 'p')).toBe(':p');
  });

  it('refuses identifiers that are not plain names', () => {
    expect(() => quoteIdentifier('a`b')).toThrow();
    expect(() => quoteIdentifier('A')).toThrow();
    expect(quoteIdentifier('wallet_tdh')).toBe('`wallet_tdh`');
  });
});
