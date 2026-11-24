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
const SAVED = 1_764_201_600_000;

/** The index's state row after a run that caught up with its read. */
function aState(fields: Record<string, unknown> = {}) {
  return {
    last_full_at: '1764201000000',
    network: NET,
    last_error: null,
    feed_next: '101',
    read_height: '100',
    feed_part: 0,
    full_phase: null,
    updated_at: String(SAVED),
    ...fields
  };
}

describe('chainIndexProgress and chainIndexReady', () => {
  const progress = (state: unknown, network: string | null = null) =>
    chainIndexProgress(aReader(() => [state]).db, undefined, network);

  it("reads the index's state row: ready once a full read has finished, read through its last caught-up save", async () => {
    const reader = aReader(() => [aState()]);
    expect(await chainIndexProgress(reader.db)).toEqual({
      ready: true,
      readThrough: SAVED - READ_THROUGH_MARGIN_MS
    });
    expect(reader.calls[0].sql).toMatch(/from waves_chain_index_state/);
    expect(reader.calls[0].params).toEqual({ name: 'waves' });
    expect(await chainIndexReady(aReader(() => [aState()]).db)).toBe(true);
    for (const state of [aState({ last_full_at: null }), undefined]) {
      expect(
        await chainIndexProgress(aReader(() => (state ? [state] : [])).db)
      ).toEqual({ ready: false, readThrough: null });
    }
  });

  it('is ready only on the expected network, in any case', async () => {
    expect(
      (await progress(aState(), NET.toUpperCase().replace('0X', '0x'))).ready
    ).toBe(true);
    expect((await progress(aState(), `0x${'cd'.repeat(32)}`)).ready).toBe(
      false
    );
    expect((await progress(aState({ network: null }), NET)).ready).toBe(false);
  });

  it('has read through nothing while it is behind its read, failing, mid-block, or before a full read has its waves', async () => {
    for (const fields of [
      { feed_next: '100' },
      { feed_next: null },
      { last_error: 'gateway down' },
      { feed_part: 2 },
      { full_phase: 'groups' },
      { full_phase: 'waves' }
    ]) {
      expect(await progress(aState(fields))).toEqual({
        ready: true,
        readThrough: null
      });
    }
    // A full read past its waves (its decisions, or the sweep) reads on.
    expect(
      (await progress(aState({ full_phase: 'decisions' }))).readThrough
    ).toBe(SAVED - READ_THROUGH_MARGIN_MS);
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
