import type { PoolConnection } from 'mysql';
import * as fc from 'fast-check';
import {
  isProxySessionPinned,
  markProxySessionPinned,
  oversizedStatementBytes,
  PROXY_PIN_STATEMENT_BYTES,
  releaseOrRetireProxySession,
  retireProxySession,
  sqlFingerprint
} from './proxy-session-pinning';

function fakeConnection(destroyError?: Error) {
  const release = jest.fn();
  const destroy = jest.fn(() => {
    if (destroyError) throw destroyError;
  });
  return {
    connection: { release, destroy } as unknown as PoolConnection,
    release,
    destroy
  };
}

describe('oversizedStatementBytes', () => {
  it('accepts statements up to the threshold and reports larger ones', () => {
    expect(oversizedStatementBytes('x'.repeat(PROXY_PIN_STATEMENT_BYTES))).toBe(
      null
    );
    expect(
      oversizedStatementBytes('x'.repeat(PROXY_PIN_STATEMENT_BYTES + 1))
    ).toBe(PROXY_PIN_STATEMENT_BYTES + 1);
  });

  it('measures UTF-8 bytes rather than UTF-16 length', () => {
    // 6,000 three-byte characters: 6,000 code units but 18,000 bytes.
    expect(oversizedStatementBytes('€'.repeat(6_000))).toBe(18_000);
    expect(oversizedStatementBytes('€'.repeat(5_000))).toBe(null);
    // Surrogate pairs: two code units, four bytes.
    expect(oversizedStatementBytes('😀'.repeat(4_001))).toBe(16_004);
  });

  it('matches Buffer.byteLength for arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 9_000 }), (text) => {
        const bytes = Buffer.byteLength(text, 'utf8');
        expect(oversizedStatementBytes(text)).toBe(
          bytes > PROXY_PIN_STATEMENT_BYTES ? bytes : null
        );
      }),
      { numRuns: 200 }
    );
  });
});

describe('sqlFingerprint', () => {
  it('removes inlined values and collapses literal lists', () => {
    const fingerprint = sqlFingerprint(
      `select * from waves w where w.id in ('a-secret', 'b\\'secret', "c-secret") and w.serial_no > 4711 and w.wallet = 0xdeadbeef`
    );
    expect(fingerprint).toBe(
      'select * from waves w where w.id in (?+) and w.serial_no > ? and w.wallet = ?'
    );
  });

  it('collapses inlined bulk insert tuples', () => {
    expect(
      sqlFingerprint(
        "INSERT INTO `notifications` (`id`, `body`) VALUES ('1', 'secret'), ('2', 'other')"
      )
    ).toBe('INSERT INTO `notifications` (`id`, `body`) VALUES (?+)+');
  });

  it('keeps placeholders and backtick identifiers, drops comments', () => {
    expect(
      sqlFingerprint(
        "/* it's a comment */ select `t1`.id -- don't\n from t1 where id = :id # it's"
      )
    ).toBe('select `t1`.id from t1 where id = :id');
  });

  it('drops everything after an unterminated quote', () => {
    expect(sqlFingerprint("select 1 from t where name = 'secret")).toBe(
      'select ? from t where name ='
    );
  });

  it('caps the fingerprint length', () => {
    const fingerprint = sqlFingerprint(`select ${'col, '.repeat(200)} 1`);
    expect(fingerprint.startsWith('select col, col,')).toBe(true);
    expect(fingerprint.length).toBeGreaterThan(110);
    expect(fingerprint.length).toBeLessThanOrEqual(120);
  });

  it('never returns a quoted string literal', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (secret) => {
        const marker = `zq${secret.replace(/\W/g, '')}qz`;
        const sql = `select * from t where a = '${marker}' and b in ("${marker}", '${marker}')`;
        expect(sqlFingerprint(sql)).not.toContain(marker);
      }),
      { numRuns: 100 }
    );
  });
});

describe('proxy session disposal', () => {
  const lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  afterEach(() => {
    jest.restoreAllMocks();
    if (lambdaName === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = lambdaName;
  });

  it('returns an unpinned connection to the pool', () => {
    const { connection, release, destroy } = fakeConnection();
    releaseOrRetireProxySession(connection, 'READ');
    expect(release).toHaveBeenCalledTimes(1);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('destroys a pinned connection instead of releasing it, once', () => {
    const { connection, release, destroy } = fakeConnection();
    markProxySessionPinned(connection, { reason: 'oversized_statement' });
    expect(isProxySessionPinned(connection)).toBe(true);
    releaseOrRetireProxySession(connection, 'TRANSACTION');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    expect(isProxySessionPinned(connection)).toBe(false);
  });

  it('falls back to release when the driver cannot destroy', () => {
    const { connection, release, destroy } = fakeConnection(
      new Error('no socket')
    );
    markProxySessionPinned(connection, { reason: 'oversized_statement' });
    releaseOrRetireProxySession(connection, 'WRITE');
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('lets direct retirement failures reach the caller', () => {
    const failure = new Error('no socket');
    const { connection } = fakeConnection(failure);
    expect(() =>
      retireProxySession(connection, 'TRANSACTION', {
        reason: 'session_settings'
      })
    ).toThrow(failure);
  });

  it('emits one value-free EMF record per retirement inside Lambda', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const { connection } = fakeConnection();
    markProxySessionPinned(connection, {
      reason: 'oversized_statement',
      fingerprint: sqlFingerprint("select * from t where id in ('secret')"),
      statementBytes: 20_000
    });
    // The first pin is kept.
    markProxySessionPinned(connection, { reason: 'session_settings' });
    releaseOrRetireProxySession(connection, 'READ');
    const lines = write.mock.calls.map(([line]) => String(line));
    const records = lines
      .filter((line) => line.includes('ProxyPinnedSessionRetired'))
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      Pool: 'READ',
      Reason: 'oversized_statement',
      ProxyPinnedSessionRetired: 1,
      ProxyPinStatementBytes: 20_000,
      fingerprint: 'select * from t where id in (?)'
    });
    expect(records[0]._aws.CloudWatchMetrics[0]).toMatchObject({
      Namespace: '6529/DbProxy',
      Dimensions: [['Environment', 'Pool', 'Reason']]
    });
    expect(lines.join('')).not.toContain('secret');
  });
});
