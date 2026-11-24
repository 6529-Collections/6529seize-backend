import {
  chainIndexProgress,
  chainIndexReady,
  expectedChainNetwork,
  isMissingTableError,
  READ_THROUGH_MARGIN_MS,
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

const NET = `0x${'ab'.repeat(32)}`;
/** The finalized block time of the height the index read at. */
const READ_TIME = 1_764_201_600_000;
const MINUTE = 60_000;

/** The index's state row after a run that caught up with its read. */
function aState(fields: Record<string, unknown> = {}) {
  return {
    name: 'waves',
    last_full_at: '1764201000000',
    network: NET,
    last_error: null,
    feed_next: '101',
    read_height: '100',
    read_time: String(READ_TIME),
    feed_part: 0,
    full_phase: null,
    updated_at: String(READ_TIME + 60 * MINUTE),
    ...fields
  };
}

const ready = (readThrough: number | null) => ({
  ready: true,
  notReady: null,
  lastError: null,
  readThrough
});

describe('chainIndexProgress and chainIndexReady', () => {
  const progress = (state: unknown, network: string | null = null) =>
    chainIndexProgress(aReader(() => [state]).db, undefined, network);

  it("reads the index's whole state row: ready once a full read has finished, read through its read's block time less five minutes", async () => {
    const reader = aReader(() => [aState()]);
    expect(await chainIndexProgress(reader.db)).toEqual(
      ready(READ_TIME - 5 * MINUTE)
    );
    expect(READ_THROUGH_MARGIN_MS).toBe(5 * MINUTE);
    expect(reader.calls[0].sql).toBe(
      'select * from waves_chain_index_state where name = :name'
    );
    expect(reader.calls[0].params).toEqual({ name: 'waves' });
    expect(await chainIndexReady(aReader(() => [aState()]).db)).toBe(true);
  });

  it('says why it is not ready', async () => {
    expect(await chainIndexProgress(aReader(() => missingTable()).db)).toEqual({
      ready: false,
      notReady: 'no_tables',
      lastError: null,
      readThrough: null
    });
    expect(await chainIndexProgress(aReader(() => []).db)).toEqual({
      ready: false,
      notReady: 'no_state',
      lastError: null,
      readThrough: null
    });
    expect(
      await progress(aState({ last_full_at: null, last_error: 'gateway down' }))
    ).toEqual({
      ready: false,
      notReady: 'no_full_read',
      lastError: 'gateway down',
      readThrough: null
    });
    expect(await progress(aState(), `0x${'cd'.repeat(32)}`)).toEqual({
      ready: false,
      notReady: 'other_network',
      lastError: null,
      readThrough: null
    });
  });

  it('is ready only on the expected network, in any case', async () => {
    expect(
      (await progress(aState(), NET.toUpperCase().replace('0X', '0x'))).ready
    ).toBe(true);
    expect((await progress(aState({ network: null }), NET)).ready).toBe(false);
    // Without the column (an index schema before it), only with no network.
    const { network: _network, ...older } = aState();
    expect((await progress(older, NET)).ready).toBe(false);
    expect((await progress(older)).ready).toBe(true);
  });

  it('follows the chain, not the clock: a head that stands still reads through the same time however often the index saves', async () => {
    for (const savedMinutesLater of [1, 60, 24 * 60]) {
      expect(
        await progress(
          aState({ updated_at: String(READ_TIME + savedMinutesLater * MINUTE) })
        )
      ).toEqual(ready(READ_TIME - 5 * MINUTE));
    }
  });

  it('has read through nothing while it is behind its read, failing, mid-block, before a full read has its waves, or keeps no read time', async () => {
    const { read_time: _readTime, ...noColumn } = aState();
    for (const state of [
      aState({ feed_next: '100' }),
      aState({ feed_next: null }),
      aState({ feed_part: 2 }),
      aState({ full_phase: 'groups' }),
      aState({ full_phase: 'waves' }),
      aState({ read_time: null }),
      noColumn
    ]) {
      expect(await progress(state)).toEqual(ready(null));
    }
    expect(await progress(aState({ last_error: 'gateway down' }))).toEqual({
      ...ready(null),
      lastError: 'gateway down'
    });
    // A full read past its waves (its decisions, or the sweep) reads on.
    expect(
      (await progress(aState({ full_phase: 'decisions' }))).readThrough
    ).toBe(READ_TIME - 5 * MINUTE);
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

  it('takes the expected network from WAVES_SETTLEMENT_NETWORK_ID', () => {
    expect(expectedChainNetwork({})).toBeNull();
    expect(
      expectedChainNetwork({ WAVES_SETTLEMENT_NETWORK_ID: ' ' })
    ).toBeNull();
    expect(
      expectedChainNetwork({
        WAVES_SETTLEMENT_NETWORK_ID: ` ${NET.toUpperCase()} `
      })
    ).toBe(NET.toUpperCase().toLowerCase());
  });
});

describe('wavesOnChain', () => {
  const chainId = `0x${'ab'.repeat(32)}`;
  const rows = [
    {
      wave_id: `0x${'11'.repeat(32)}`,
      legacy_id: 'imported-wave',
      origin: 'legacy'
    },
    { wave_id: chainId, legacy_id: null, origin: 'native' },
    // Made on the chain with a legacy id: not 6529.io's wave of that id.
    {
      wave_id: `0x${'22'.repeat(32)}`,
      legacy_id: 'site-wave',
      origin: 'native'
    },
    // An imported wave by its chain id: 6529.io knows it by its legacy id.
    {
      wave_id: `0x${'33'.repeat(32)}`,
      legacy_id: 'other-imported',
      origin: 'legacy'
    }
  ];

  it('holds an imported wave by its legacy id and a chain-made one by its chain id, in lowercase, each on its own kind of row', async () => {
    const reader = aReader(() => rows);
    const held = await wavesOnChain(reader.db, [
      'Imported-Wave',
      chainId.toUpperCase().replace('0X', '0x'),
      'site-wave',
      ' ',
      'imported-wave',
      `0x${'33'.repeat(32)}`
    ]);
    expect(held).toEqual(new Set(['imported-wave', chainId]));
    expect(reader.calls).toHaveLength(1);
    expect(reader.calls[0].sql).toMatch(
      /from chain_waves\s+where \(legacy_id in \(:ids\) and origin = 'legacy'\)\s+or \(wave_id in \(:ids\) and origin = 'native'\)/
    );
    expect(reader.calls[0].params).toEqual({
      ids: ['imported-wave', chainId, 'site-wave', `0x${'33'.repeat(32)}`]
    });
  });

  it('asks nothing for no ids', async () => {
    const reader = aReader(() => rows);
    expect(await wavesOnChain(reader.db, [])).toEqual(new Set());
    expect(reader.calls).toEqual([]);
  });
});

describe('waveOnChainSql', () => {
  it("matches the wave by an imported row's legacy id or a chain-made row's chain id", () => {
    expect(waveOnChainSql('w.id')).toBe(
      "(exists (select 1 from chain_waves cwm_legacy where cwm_legacy.legacy_id = w.id and cwm_legacy.origin = 'legacy') or exists (select 1 from chain_waves cwm_chain where cwm_chain.wave_id = w.id and cwm_chain.origin = 'native'))"
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
