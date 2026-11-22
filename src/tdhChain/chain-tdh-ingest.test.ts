import {
  chainDayFixture,
  fixtureWallet,
  siteFixture,
  SiteFixture,
  siteFixtureRows
} from '@/tests/fixtures/tdh-chain-day.fixture';
import {
  ChainTdhIngestDeps,
  ChainTdhRows,
  INDEX_MARGIN_BLOCKS,
  ingestChainDay,
  runFollowUpSteps
} from './chain-tdh-ingest';
import {
  CHAIN_DAY_STEPS,
  ChainDayStep,
  SaveTdhChainDay
} from './tdh-chain-days.db';
import { TdhChainDay } from './tdh-chain.types';

const X = `${fixtureWallet('1')}-${fixtureWallet('3')}`;

function deps(
  opts: {
    computed?: SiteFixture;
    live?: SiteFixture;
    width?: number;
    ethHash?: string;
    tdhBlock?: number;
    indexed?: number;
    now?: number;
    failStep?: ChainDayStep;
  } = {}
) {
  const day = chainDayFixture();
  const saved: SaveTdhChainDay[] = [];
  const written: { rows: ChainTdhRows; record: SaveTdhChainDay }[] = [];
  const calls: string[] = [];
  const stepsDone: ChainDayStep[] = [];
  const d: ChainTdhIngestDeps = {
    ethBlocks: {
      getBlock: async (n) =>
        n === day.header.cutoffNumber
          ? {
              hash: opts.ethHash ?? day.header.cutoffHash,
              timestamp: day.header.cutoffTimestamp
            }
          : { hash: '0x00', timestamp: day.header.boundary + 12 }
    },
    async computeWallets(block, blockTimestamp, clusters) {
      calls.push(
        `compute ${block} ${blockTimestamp.getTime()} ${clusters.walletsOf(fixtureWallet('3')).length}`
      );
      const rows = siteFixtureRows(opts.computed ?? siteFixture());
      return { tdh: rows.wallets, memesTdh: [], tdhEditions: [] };
    },
    async consolidate(walletRows) {
      calls.push(`consolidate ${walletRows.length}`);
      return {
        adjustedSeasons: [],
        consolidatedTdh: siteFixtureRows(opts.computed ?? siteFixture())
          .consolidated
      };
    },
    async rerank(wallets, consolidated) {
      calls.push('rerank');
      return { wallets, consolidated };
    },
    async readLive(block) {
      calls.push(`live ${block}`);
      return siteFixtureRows(opts.live ?? siteFixture());
    },
    async writeDay(rows, record) {
      calls.push('write');
      written.push({ rows, record });
    },
    steps: {
      async run(step) {
        if (step === opts.failStep) throw new Error(`${step} failed`);
        calls.push(`step ${step}`);
      },
      async markDone(_cycleDay, step) {
        stepsDone.push(step);
        return [...stepsDone];
      }
    },
    keyWidth: async () => opts.width ?? 200,
    latestTdhBlock: async () => opts.tdhBlock ?? 0,
    transactionsIndexedTo: async () =>
      opts.indexed ?? day.header.cutoffNumber + INDEX_MARGIN_BLOCKS,
    async saveDay(s) {
      saved.push(s);
    },
    now: () => opts.now ?? day.header.boundary * 1000 + 3_600_000
  };
  return { d, saved, written, calls, day, stepsDone };
}

describe('ingestChainDay', () => {
  it('records a day that fails its checks and computes nothing', async () => {
    const t = deps();
    const bad: TdhChainDay = {
      ...t.day,
      header: { ...t.day.header, totalTdh: 1 }
    };
    const r = await ingestChainDay(bad, 'CHAIN', t.d);
    expect(r.status).toBe('FAILED');
    expect(t.calls).toEqual([]);
    expect(t.saved.map((s) => s.status)).toEqual(['FAILED']);
    expect(t.written).toEqual([]);
  });

  it('records a cutoff block that Ethereum disagrees with as FAILED', async () => {
    const t = deps({ ethHash: `0x${'0'.repeat(64)}` });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.status).toBe('FAILED');
    expect(r.summary.failures.map((f) => f.check)).toEqual(['ETH_CUTOFF']);
  });

  it('in CHAIN never writes an older day over a newer one', async () => {
    const t = deps({ tdhBlock: chainDayFixture().header.cutoffNumber + 7000 });
    const r = await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(r.status).toBe('SKIPPED');
    expect(t.calls).toEqual([]);
    expect(t.saved.map((s) => s.status)).toEqual(['SKIPPED']);
  });

  it('waits for the transaction index, then gives way three hours past the boundary', async () => {
    const day = chainDayFixture();
    const early = deps({ indexed: day.header.cutoffNumber + 10 });
    expect((await ingestChainDay(early.day, 'CHAIN', early.d)).status).toBe(
      'WAITING'
    );
    expect(early.saved).toEqual([]);
    expect(early.calls).toEqual([]);
    const late = deps({
      indexed: day.header.cutoffNumber + 10,
      now: day.header.boundary * 1000 + 3 * 3_600_000 + 1
    });
    expect((await ingestChainDay(late.day, 'CHAIN', late.d)).status).toBe(
      'INGESTED'
    );
  });

  it('in SHADOW compares with the computation and the live tables, and writes no TDH table', async () => {
    const t = deps();
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.status).toBe('INGESTED');
    expect(r.verdict).toBe('MATCH');
    expect(t.calls).toEqual([
      `compute ${t.day.header.cutoffNumber} ${t.day.header.cutoffTimestamp * 1000} 2`,
      'consolidate 6',
      `live ${t.day.header.cutoffNumber}`
    ]);
    expect(t.written).toEqual([]);
    expect(t.saved[0]).toMatchObject({
      mode: 'SHADOW',
      status: 'INGESTED',
      verdict: 'MATCH'
    });
    expect(r.summary.rowDiff!.wallets.byField).toEqual({});
  });

  it('in SHADOW reports a live table that differs from the chain', async () => {
    const live = siteFixture();
    live.wallets[fixtureWallet('2')].boostedTdh = 251;
    const t = deps({ live });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.verdict).toBe('MISMATCH');
    expect((r.summary.live as any).counts).toEqual({ WALLET_TDH: 1 });
    expect(r.summary.rowDiff!.wallets.byField).toEqual({ boosted_tdh: 1 });
  });

  it('in SHADOW records live tables it cannot read as a mismatch instead of failing', async () => {
    const live = siteFixture();
    live.identities.push({
      wallets: [fixtureWallet('2')],
      boostedTdh: 1,
      boost: 1
    });
    const t = deps({ live });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.verdict).toBe('MISMATCH');
    expect((r.summary.live as any).error).toMatch(/twice|also in/);
  });

  it('reports MATCH_WITHOUT_TOKENS when the chain side has no token list', async () => {
    const t = deps();
    const r = await ingestChainDay(
      { ...t.day, tokenLeaves: null },
      'SHADOW',
      t.d
    );
    expect(r.verdict).toBe('MATCH_WITHOUT_TOKENS');
  });

  it('in CHAIN writes the chain values, records the day in the write, then runs every step once', async () => {
    const computed = siteFixture();
    computed.wallets[fixtureWallet('3')].boostedTdh = 401;
    const t = deps({ computed });
    const r = await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(r).toMatchObject({
      status: 'INGESTED',
      verdict: 'MISMATCH',
      deferredKeys: []
    });
    expect(t.calls.filter((c) => c === 'rerank')).toHaveLength(1);
    expect(t.calls.filter((c) => c.startsWith('step '))).toEqual(
      CHAIN_DAY_STEPS.map((s) => `step ${s}`)
    );
    expect(t.calls.indexOf('write')).toBeLessThan(t.calls.indexOf('step nfts'));
    const w = t.written[0];
    expect(w.record).toMatchObject({
      mode: 'CHAIN',
      status: 'WRITTEN',
      verdict: 'MISMATCH'
    });
    expect(
      w.rows.wallets.tdh.find((x) => x.wallet === fixtureWallet('3'))!
        .boosted_tdh
    ).toBe(400);
    expect(
      w.rows.consolidated.every(
        (c) => c.date.getTime() === t.day.apply.applyTimeMs
      )
    ).toBe(true);
    expect(t.saved).toEqual([]);
    expect(t.stepsDone).toEqual([...CHAIN_DAY_STEPS]);
  });

  it('in CHAIN leaves the day WRITTEN when a step fails, so the next run resumes it', async () => {
    const t = deps({ failStep: 'uploads' });
    await expect(ingestChainDay(t.day, 'CHAIN', t.d)).rejects.toThrow(
      'uploads failed'
    );
    expect(t.written).toHaveLength(1);
    expect(t.stepsDone).toEqual(['nfts', 'history', 'metrics']);
    const resumed: string[] = [];
    const done = await runFollowUpSteps(t.day.header.cycleDay, t.stepsDone, {
      run: async (step) => {
        resumed.push(step);
      },
      markDone: async (_d, step) => [...t.stepsDone, step]
    });
    expect(resumed).toEqual(['uploads', 'dayFiles']);
    expect(done).toContain('dayFiles');
  });

  it('in CHAIN leaves out consolidations whose key is too wide and queues them', async () => {
    const t = deps({ width: 50 });
    const r = await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(r.deferredKeys).toEqual([X]);
    const w = t.written[0];
    expect(w.rows.consolidated.map((c) => c.consolidation_key)).not.toContain(
      X
    );
    expect(w.rows.consolidated).toHaveLength(4);
    expect(w.rows.wallets.tdh).toHaveLength(6);
    expect(w.record).toMatchObject({ status: 'WRITTEN', deferredKeys: [X] });
  });

  it('does not rank again when nothing changed', async () => {
    const t = deps();
    await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(t.calls).not.toContain('rerank');
  });
});
