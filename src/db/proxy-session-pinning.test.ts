import * as mysql from 'mysql';
import type { PoolConnection } from 'mysql';
import * as fc from 'fast-check';
import {
  isProxySessionPinned,
  markProxySessionPinned,
  oversizedStatementBytes,
  PROXY_PIN_STATEMENT_BYTES,
  releaseOrRetireProxySession,
  retireProxySession,
  sqlFingerprint,
  withProxyPinScope
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

  it('quarantines instead of releasing when destroy throws on release', () => {
    const { connection, release, destroy } = fakeConnection(
      new Error('no socket')
    );
    markProxySessionPinned(connection, { reason: 'oversized_statement' });
    expect(() =>
      releaseOrRetireProxySession(connection, 'WRITE')
    ).not.toThrow();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    // A later release of the same object still never returns it to the pool.
    releaseOrRetireProxySession(connection, 'WRITE');
    expect(release).not.toHaveBeenCalled();
  });

  it('keeps telemetry failures out of the release path', () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    jest.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw new Error('stdout closed');
    });
    const { connection, destroy } = fakeConnection();
    markProxySessionPinned(connection, { reason: 'oversized_statement' });
    expect(() => releaseOrRetireProxySession(connection, 'READ')).not.toThrow();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('reports a quarantine instead of throwing when destroy fails', () => {
    const { connection } = fakeConnection(new Error('no socket'));
    expect(
      retireProxySession(connection, 'TRANSACTION', {
        reason: 'session_settings'
      })
    ).toBe('quarantined');
    const healthy = fakeConnection();
    expect(
      retireProxySession(healthy.connection, 'TRANSACTION', {
        reason: 'session_settings'
      })
    ).toBe('destroyed');
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
      When: 'release',
      ProxyPinnedSessionRetired: 1,
      ProxyPinStatementBytes: 20_000,
      fingerprint: 'select * from t where id in (?)'
    });
    expect(records[0]._aws.CloudWatchMetrics[0]).toMatchObject({
      Namespace: '6529/DbProxy',
      Dimensions: [['Environment', 'Pool', 'Reason', 'When']]
    });
    expect(lines.join('')).not.toContain('secret');
  });
});

/** mysql 2.x pool shape: released connections wait in `_freeConnections`. */
function fakePool(options: { failDestroy?: boolean } = {}) {
  const pool = { _freeConnections: [] as PoolConnection[] };
  const created: ReturnType<typeof fakeConnection>[] = [];
  const acquire = (): PoolConnection => {
    const idle = pool._freeConnections.shift();
    if (idle) return idle;
    const driver = fakeConnection();
    const connection = driver.connection as unknown as { _pool: unknown };
    connection._pool = pool;
    driver.release.mockImplementation(() => {
      pool._freeConnections.push(driver.connection);
    });
    driver.destroy.mockImplementation(() => {
      if (options.failDestroy) throw new Error('no socket');
      const index = pool._freeConnections.indexOf(driver.connection);
      if (index !== -1) pool._freeConnections.splice(index, 1);
      connection._pool = null;
    });
    created.push(driver);
    return driver.connection;
  };
  return { acquire, created, idle: pool._freeConnections };
}

function pinnedStatement(connection: PoolConnection): void {
  markProxySessionPinned(connection, {
    reason: 'oversized_statement',
    statementBytes: 20_000
  });
  releaseOrRetireProxySession(connection, 'READ');
}

describe('request-scoped retirement', () => {
  const lambdaName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  afterEach(() => {
    jest.restoreAllMocks();
    if (lambdaName === undefined) delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    else process.env.AWS_LAMBDA_FUNCTION_NAME = lambdaName;
  });

  it('reuses one pinned connection for a whole request and retires it once at the end', async () => {
    const pool = fakePool();
    await withProxyPinScope(async () => {
      for (let i = 0; i < 5; i++) {
        pinnedStatement(pool.acquire());
        await Promise.resolve();
      }
      expect(pool.created).toHaveLength(1);
      expect(pool.created[0].release).toHaveBeenCalledTimes(5);
      expect(pool.created[0].destroy).not.toHaveBeenCalled();
    });
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
    // The next request opens exactly one replacement.
    pool.acquire();
    expect(pool.created).toHaveLength(2);
  });

  it('retires pinned connections when the request fails', async () => {
    const pool = fakePool();
    const failure = new Error('handler failed');
    await expect(
      withProxyPinScope(async () => {
        pinnedStatement(pool.acquire());
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves unpinned connections in the pool', async () => {
    const pool = fakePool();
    await withProxyPinScope(async () => {
      releaseOrRetireProxySession(pool.acquire(), 'READ');
    });
    expect(pool.created[0].destroy).not.toHaveBeenCalled();
  });

  it('does not touch a pinned connection that is borrowed at request end', async () => {
    const pool = fakePool();
    let background: PoolConnection | undefined;
    await withProxyPinScope(async () => {
      pinnedStatement(pool.acquire());
      // Background work borrows it again and outlives the request.
      background = pool.acquire();
    });
    expect(pool.created[0].destroy).not.toHaveBeenCalled();
    // Its later release happens outside an open scope and retires it.
    releaseOrRetireProxySession(background!, 'READ');
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(isProxySessionPinned(background!)).toBe(false);
  });

  it('retires at release when background work of an ended request releases it', async () => {
    const pool = fakePool();
    let background: Promise<void> | undefined;
    await withProxyPinScope(async () => {
      const connection = pool.acquire();
      // This continuation runs in the request's scope after it has closed.
      background = new Promise<void>((resolve) => setTimeout(resolve, 5)).then(
        () => pinnedStatement(connection)
      );
    });
    expect(pool.created[0].destroy).not.toHaveBeenCalled();
    await background;
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(pool.created[0].release).not.toHaveBeenCalled();
  });

  it('destroys pinning outside any request scope at release', () => {
    const pool = fakePool();
    pinnedStatement(pool.acquire());
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(pool.created[0].release).not.toHaveBeenCalled();
  });

  it('records request-end retirements and the per-request count', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'seizeAPI';
    const write = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const pool = fakePool();
    await withProxyPinScope(async () => {
      const first = pool.acquire();
      const second = pool.acquire();
      pinnedStatement(first);
      pinnedStatement(second);
    });
    const records = write.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(
      records.filter((record) => record.ProxyPinnedSessionRetired === 1)
    ).toEqual([
      expect.objectContaining({ When: 'request_end', Pool: 'READ' }),
      expect.objectContaining({ When: 'request_end', Pool: 'READ' })
    ]);
    expect(
      records.filter(
        (record) => record.event === 'db_proxy_pins_at_request_end'
      )
    ).toEqual([
      expect.objectContaining({
        ProxyPinnedSessionsRetiredPerRequest: 2,
        deferred: 0
      })
    ]);
  });

  it('quarantines an idle pinned connection whose destroy throws at request end', async () => {
    const pool = fakePool({ failDestroy: true });
    let pinned: PoolConnection | undefined;
    await withProxyPinScope(async () => {
      pinned = pool.acquire();
      pinnedStatement(pinned);
      expect(pool.idle).toEqual([pinned]);
    });
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
    // Taken out of the idle list: the next borrower gets a new connection.
    expect(pool.idle).toEqual([]);
    expect(pool.acquire()).not.toBe(pinned);
    // And it is never released back, even by a stray owner.
    releaseOrRetireProxySession(pinned!, 'READ');
    expect(pool.created[0].release).toHaveBeenCalledTimes(1);
    expect(pool.idle).toEqual([]);
  });

  it('retires a deferred pin at a later request end even if released elsewhere', async () => {
    const pool = fakePool();
    let borrowed: PoolConnection | undefined;
    await withProxyPinScope(async () => {
      pinnedStatement(pool.acquire());
      borrowed = pool.acquire();
    });
    expect(pool.created[0].destroy).not.toHaveBeenCalled();
    // Released straight to the pool, bypassing this module.
    borrowed!.release();
    expect(pool.idle).toEqual([borrowed]);
    // A later request that pinned nothing still sweeps the deferred pin.
    await withProxyPinScope(async () => undefined);
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
    expect(isProxySessionPinned(borrowed!)).toBe(false);
  });

  it('lets a later request adopt a deferred pin released inside it', async () => {
    const pool = fakePool();
    let borrowed: PoolConnection | undefined;
    await withProxyPinScope(async () => {
      pinnedStatement(pool.acquire());
      borrowed = pool.acquire();
    });
    await withProxyPinScope(async () => {
      releaseOrRetireProxySession(borrowed!, 'READ');
      expect(pool.created[0].destroy).not.toHaveBeenCalled();
    });
    expect(pool.created[0].destroy).toHaveBeenCalledTimes(1);
  });

  it('stops tracking a deferred pin the driver dropped', async () => {
    const pool = fakePool();
    let borrowed: PoolConnection | undefined;
    await withProxyPinScope(async () => {
      pinnedStatement(pool.acquire());
      borrowed = pool.acquire();
    });
    // The driver removed it from the pool (fatal error or socket end).
    (borrowed as unknown as { _pool: unknown })._pool = null;
    await withProxyPinScope(async () => undefined);
    expect(pool.created[0].destroy).not.toHaveBeenCalled();
    expect(isProxySessionPinned(borrowed!)).toBe(false);
  });

  it('recognizes idle connections in a real mysql pool', async () => {
    const pool = mysql.createPool({ host: '127.0.0.1', connectionLimit: 1 });
    const destroy = jest.fn();
    const connection = {
      _pool: pool,
      destroy,
      release() {
        (
          pool as unknown as { releaseConnection(c: unknown): void }
        ).releaseConnection(this);
      }
    } as unknown as PoolConnection;
    await withProxyPinScope(async () => {
      pinnedStatement(connection);
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
