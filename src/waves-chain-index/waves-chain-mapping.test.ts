import {
  chainIndexReady,
  isMissingTableError,
  waveOnChainSql,
  wavesOnChain
} from './waves-chain-mapping';

type Call = { sql: string; params: Record<string, any> | undefined };

function aReader(answer: (sql: string) => unknown[] | Error) {
  const calls: Call[] = [];
  return {
    calls,
    db: {
      async execute<T>(sql: string, params?: Record<string, any>) {
        calls.push({ sql, params });
        const out = answer(sql);
        if (out instanceof Error) throw out;
        return out as T[];
      }
    }
  };
}

function missingTable(): Error {
  return Object.assign(new Error("Table 'chain_waves' doesn't exist"), {
    code: 'ER_NO_SUCH_TABLE',
    errno: 1146
  });
}

describe('chainIndexReady', () => {
  it("reads the index's state row: ready once a full read has finished", async () => {
    const done = aReader(() => [{ last_full_at: '1764201600000' }]);
    expect(await chainIndexReady(done.db)).toBe(true);
    expect(done.calls[0].sql).toMatch(/from waves_chain_index_state/);
    expect(done.calls[0].params).toEqual({ name: 'waves' });
    const reading = aReader(() => [{ last_full_at: null }]);
    expect(await chainIndexReady(reading.db)).toBe(false);
    const none = aReader(() => []);
    expect(await chainIndexReady(none.db)).toBe(false);
  });

  it("is not ready while the index's tables aren't there; other errors throw", async () => {
    expect(await chainIndexReady(aReader(() => missingTable()).db)).toBe(false);
    const wrapped = Object.assign(new Error('query failed'), {
      driverError: { code: 'ER_NO_SUCH_TABLE' }
    });
    expect(await chainIndexReady(aReader(() => wrapped).db)).toBe(false);
    await expect(
      chainIndexReady(aReader(() => new Error('connection lost')).db)
    ).rejects.toThrow('connection lost');
  });
});

describe('wavesOnChain', () => {
  const chainId = `0x${'ab'.repeat(32)}`;
  const rows = [
    { wave_id: `0x${'11'.repeat(32)}`, legacy_id: 'imported-wave' },
    { wave_id: chainId, legacy_id: null }
  ];

  it('holds an imported wave by its legacy id and a chain-made one by its chain id, in lowercase', async () => {
    const reader = aReader(() => rows);
    const held = await wavesOnChain(reader.db, [
      'Imported-Wave',
      chainId.toUpperCase().replace('0X', '0x'),
      'site-wave',
      ' ',
      'imported-wave'
    ]);
    expect(held).toEqual(new Set(['imported-wave', chainId]));
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0].sql).toMatch(
      /from chain_waves\s+where legacy_id in \(:ids\) or wave_id in \(:ids\)/
    );
    expect(reader.calls[0].params).toEqual({
      ids: ['imported-wave', chainId, 'site-wave']
    });
  });

  it('asks nothing for no ids', async () => {
    const reader = aReader(() => rows);
    expect(await wavesOnChain(reader.db, [])).toEqual(new Set());
    expect(reader.calls).toEqual([]);
  });
});

describe('waveOnChainSql', () => {
  it("matches the wave by the chain index's legacy id or chain id", () => {
    expect(waveOnChainSql('w.id')).toBe(
      '(exists (select 1 from chain_waves cwm_legacy where cwm_legacy.legacy_id = w.id) or exists (select 1 from chain_waves cwm_chain where cwm_chain.wave_id = w.id))'
    );
  });
});

describe('isMissingTableError', () => {
  it('knows the driver codes for a missing table', () => {
    expect(isMissingTableError(missingTable())).toBe(true);
    expect(isMissingTableError({ errno: 1146 })).toBe(true);
    expect(isMissingTableError({ driverError: { errno: 1146 } })).toBe(true);
    expect(isMissingTableError(new Error('x'))).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
  });
});
