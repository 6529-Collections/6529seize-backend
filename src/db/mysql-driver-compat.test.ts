import fc from 'fast-check';
import * as mysql from 'mysql2';
import { CustomTypeCaster } from './my-sql.helpers';
import {
  mysql2TypeOrmOptions,
  mysqljsTypeCast,
  mysqljsWriteResult,
  TypeCastFunction,
  withMysqljsErrorCode
} from './mysql-driver-compat';
import { FakeMysqlServer, FIELD_TYPE } from '@/tests/fake-mysql-server';

/*
 * Expected values are what the mysql driver (mysqljs 2.18.1) returned for
 * the same column types and text; they were compared value by value against
 * that driver before it was removed.
 */

const RESULT = {
  columns: [
    { name: 'flag', type: FIELD_TYPE.TINY },
    { name: 'small', type: FIELD_TYPE.SHORT },
    { name: 'big', type: FIELD_TYPE.LONGLONG },
    { name: 'ratio', type: FIELD_TYPE.DOUBLE },
    { name: 'amount', type: FIELD_TYPE.NEWDECIMAL },
    { name: 'day', type: FIELD_TYPE.DATE },
    { name: 'at', type: FIELD_TYPE.DATETIME },
    { name: 'doc', type: FIELD_TYPE.JSON },
    { name: 'label', type: FIELD_TYPE.VAR_STRING },
    { name: 'bytes', type: FIELD_TYPE.BLOB, binary: true }
  ],
  rows: [
    [
      '1',
      '-7',
      '9007199254740993',
      '1234.5678901234567',
      '123.456',
      '2024-01-02',
      '2024-01-02 03:04:05.123456',
      '{"a":1,"b":"é"}',
      'héllo',
      Buffer.from([0, 255])
    ],
    [
      '0',
      null,
      '42',
      '5e-324',
      '-0.10',
      '0000-00-00',
      '0000-00-00 00:00:00',
      '"123"',
      '',
      null
    ]
  ]
};

const WRITE = {
  affectedRows: 3,
  info: 'Rows matched: 3  Changed: 2  Warnings: 0'
};

let server: FakeMysqlServer;
let port: number;

beforeAll(async () => {
  server = new FakeMysqlServer({
    onQuery: (sql) => (sql.startsWith('UPDATE') ? WRITE : RESULT)
  });
  port = await server.start();
});

afterAll(() => server.stop());

async function query(options: mysql.PoolOptions, sql = 'SELECT'): Promise<any> {
  const pool = mysql.createPool({
    host: '127.0.0.1',
    port,
    user: 'u',
    password: 'p',
    charset: 'utf8mb4',
    ...options
  });
  try {
    return await new Promise((resolve, reject) =>
      pool.query(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
    );
  } finally {
    await new Promise((resolve) => pool.end(resolve));
  }
}

describe('API pool values (CustomTypeCaster)', () => {
  it('match the mysql driver', async () => {
    const [first, second] = await query({ typeCast: CustomTypeCaster });
    expect(first).toEqual({
      flag: true,
      small: -7,
      big: BigInt('9007199254740993'),
      ratio: 1234.5678901234567,
      amount: 123.456,
      day: new Date(2024, 0, 2),
      at: new Date('2024-01-02 03:04:05.123456'),
      doc: '{"a":1,"b":"é"}',
      label: 'héllo',
      bytes: Buffer.from([0, 255])
    });
    expect(second).toEqual({
      flag: false,
      small: null,
      big: 42,
      ratio: 5e-324,
      amount: -0.1,
      day: '0000-00-00',
      at: '0000-00-00 00:00:00',
      doc: '"123"',
      label: '',
      bytes: null
    });
  });
});

describe('TypeORM values (mysql2TypeOrmOptions)', () => {
  it('match the mysql driver for the Etc/UTC data source', async () => {
    const options = mysql2TypeOrmOptions({ timezone: 'Etc/UTC' });
    expect(options).toMatchObject({
      connectorPackage: 'mysql2',
      timezone: 'Z'
    });
    const [first, second] = await query({
      supportBigNumbers: true,
      bigNumberStrings: true,
      timezone: options.timezone,
      ...options.extra
    });
    expect(first).toEqual({
      flag: 1,
      small: -7,
      big: '9007199254740993',
      ratio: 1234.5678901234567,
      amount: '123.456',
      // mysqljs could not parse dates followed by 'Etc/UTC'.
      day: '2024-01-02',
      at: '2024-01-02 03:04:05.123456',
      doc: '{"a":1,"b":"é"}',
      label: 'héllo',
      bytes: Buffer.from([0, 255])
    });
    expect(second).toMatchObject({ big: '42', amount: '-0.10', doc: '"123"' });
  });

  it('keeps valid zones and dateStrings', () => {
    expect(mysql2TypeOrmOptions().timezone).toBe('local');
    expect(mysql2TypeOrmOptions({ timezone: '+02:00' }).timezone).toBe(
      '+02:00'
    );
    const typeCast: TypeCastFunction = mysql2TypeOrmOptions({
      dateStrings: true
    }).extra.typeCast;
    expect(
      typeCast(fakeField('DATETIME', '2024-01-02 03:04:05'), () => 'next')
    ).toBe('2024-01-02 03:04:05');
  });
});

function fakeField(
  type: string,
  text: string | null
): Parameters<TypeCastFunction>[0] {
  return {
    type,
    string: () => text
  } as unknown as Parameters<TypeCastFunction>[0];
}

describe('mysqljsTypeCast', () => {
  it('reads FLOAT and DOUBLE text like Number()', () => {
    const typeCast = mysqljsTypeCast();
    fc.assert(
      fc.property(
        fc.double(),
        fc.constantFrom('FLOAT', 'DOUBLE'),
        (value, type) => {
          const text = String(value);
          expect(
            Object.is(
              typeCast(fakeField(type, text), () => undefined),
              Number(text)
            )
          ).toBe(true);
        }
      )
    );
  });

  it('keeps big numbers as mysqljs did', () => {
    const plain = mysqljsTypeCast();
    const big = mysqljsTypeCast({ supportBigNumbers: true });
    const strings = mysqljsTypeCast({
      supportBigNumbers: true,
      bigNumberStrings: true
    });
    const field = (text: string) => fakeField('NEWDECIMAL', text);
    expect(plain(field('12345678901234567890'), () => 0)).toBe(
      Number('12345678901234567890')
    );
    expect(big(field('12345678901234567890'), () => 0)).toBe(
      '12345678901234567890'
    );
    expect(big(field('12.5'), () => 0)).toBe(12.5);
    expect(strings(field('12.5'), () => 0)).toBe('12.5');
    expect(strings(fakeField('LONGLONG', null), () => 0)).toBeNull();
  });

  it('leaves other types to mysql2', () => {
    expect(mysqljsTypeCast()(fakeField('LONG', '7'), () => 'parsed')).toBe(
      'parsed'
    );
  });
});

describe('mysqljsWriteResult', () => {
  it('lays write results out like mysqljs OkPacket', async () => {
    const result = await query({}, 'UPDATE t SET x = 1');
    const serialized = Object.values(
      JSON.parse(JSON.stringify(mysqljsWriteResult(result)))
    );
    // fieldCount, affectedRows, insertId, serverStatus, warningCount,
    // message, protocol41, changedRows
    expect(serialized).toEqual([0, 3, 0, 2, 0, WRITE.info, true, 2]);
  });

  it('passes rows through', () => {
    const rows = [{ id: 1 }];
    expect(mysqljsWriteResult(rows)).toBe(rows);
  });
});

describe('withMysqljsErrorCode', () => {
  const closed = () =>
    Object.assign(
      new Error("Can't add new command when connection is in closed state"),
      { fatal: true }
    );

  it('restores the mysqljs code for a statement on a broken connection', () => {
    expect(withMysqljsErrorCode(closed(), { state: 'error' })).toMatchObject({
      code: 'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
      fatal: false
    });
  });

  it('restores the mysqljs code for a statement on a closed connection', () => {
    expect(
      withMysqljsErrorCode(closed(), { state: 'disconnected' })
    ).toMatchObject({ code: 'PROTOCOL_ENQUEUE_AFTER_DESTROY', fatal: false });
  });

  it('leaves other errors alone', () => {
    const error = Object.assign(new Error('Duplicate entry'), {
      code: 'ER_DUP_ENTRY'
    });
    expect(withMysqljsErrorCode(error, { state: 'error' })).toBe(error);
    expect(error.code).toBe('ER_DUP_ENTRY');
    expect(withMysqljsErrorCode(null, undefined)).toBeNull();
  });
});
