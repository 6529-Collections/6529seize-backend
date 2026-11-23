import {
  chainDayFixture,
  fixtureWallet,
  siteFixture,
  SiteFixture,
  siteFixtureRows
} from '@/tests/fixtures/tdh-chain-day.fixture';
import {
  ChainDayStepRunner,
  ChainTdhIngestDeps,
  ChainTdhRows,
  INDEX_MARGIN_BLOCKS,
  ingestChainDay,
  MAX_STEP_TRIES,
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
  } = {}
) {
  const day = chainDayFixture();
  const saved: SaveTdhChainDay[] = [];
  const written: { rows: ChainTdhRows; record: SaveTdhChainDay }[] = [];
  const calls: string[] = [];
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
    keyWidth: async () => opts.width ?? 200,
    latestTdhBlock: async () => opts.tdhBlock ?? 0,
    transactionsIndexedTo: async () =>
      opts.indexed ?? day.header.cutoffNumber + INDEX_MARGIN_BLOCKS,
    async saveDay(s) {
      saved.push(s);
    },
    now: () => opts.now ?? day.header.boundary * 1000 + 3_600_000
  };
  return { d, saved, written, calls, day };
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
      'WRITTEN'
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

  it('in SHADOW reports a live table that differs from the chain, without making it the verdict', async () => {
    const live = siteFixture();
    live.wallets[fixtureWallet('2')].boostedTdh = 251;
    const t = deps({ live });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    // The day is judged at the chain's cutoff and grouping, which agree.
    expect(r.verdict).toBe('MATCH');
    expect((r.summary.live as any).verdict).toBe('MISMATCH');
    expect((r.summary.live as any).counts).toEqual({ WALLET_TDH: 1 });
    expect(r.summary.liveByGrouping).toEqual({
      regroupedKeys: 0,
      regroupedWallets: 0,
      regrouped: {},
      day: {},
      other: { WALLET_TDH: 1 }
    });
    expect(r.summary.rowDiff!.wallets.byField).toEqual({ boosted_tdh: 1 });
  });

  it('in SHADOW the verdict is the computation at the chain cutoff, even when the live tables agree', async () => {
    const computed = siteFixture();
    computed.wallets[fixtureWallet('3')].boostedTdh = 401;
    const t = deps({ computed });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.verdict).toBe('MISMATCH');
    expect((r.summary.cache as any).verdict).toBe('MISMATCH');
    expect((r.summary.live as any).verdict).toBe('MATCH');
    expect(t.saved[0]).toMatchObject({ verdict: 'MISMATCH' });
  });

  it('in SHADOW counts apart the live differences of identities regrouped since the cutoff', async () => {
    // After midnight wallet 3 left wallet 1's consolidation: the delegations
    // loop reran TDH at the same block with the new grouping.
    const live = siteFixture();
    const [joined, ...rest] = live.identities;
    live.identities = [
      {
        wallets: [fixtureWallet('1')],
        boostedTdh: 1000,
        boost: 1.25,
        memes: [{ id: 1, balance: 1, tdh: 800 }]
      },
      {
        wallets: [fixtureWallet('3')],
        boostedTdh: 400,
        boost: 1.1,
        memes: [{ id: 1, balance: 1, tdh: 200 }],
        gradients: [{ id: 5, balance: 1, tdh: 200 }]
      },
      ...rest
    ];
    expect(joined.wallets).toEqual([fixtureWallet('1'), fixtureWallet('3')]);
    const t = deps({ live });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.verdict).toBe('MATCH');
    expect((r.summary.live as any).verdict).toBe('MISMATCH');
    const split = r.summary.liveByGrouping!;
    // The chain's key and the two live keys: three keys, two wallets.
    expect(split.regroupedKeys).toBe(3);
    expect(split.regroupedWallets).toBe(2);
    expect(Object.keys(split.regrouped).length).toBeGreaterThan(0);
    // Nothing the regrouping doesn't explain.
    expect(split.other).toEqual({});
  });

  it('in SHADOW records live tables it cannot read in the summary instead of failing', async () => {
    const live = siteFixture();
    live.identities.push({
      wallets: [fixtureWallet('2')],
      boostedTdh: 1,
      boost: 1
    });
    const t = deps({ live });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.verdict).toBe('MATCH');
    expect((r.summary.live as any).error).toMatch(/twice|also in/);
    expect(r.summary.liveByGrouping).toBeUndefined();
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

  it('in CHAIN writes the chain values and records the day in the same write, leaving the steps to the poller', async () => {
    const computed = siteFixture();
    computed.wallets[fixtureWallet('3')].boostedTdh = 401;
    const t = deps({ computed });
    const r = await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(r).toMatchObject({
      status: 'WRITTEN',
      verdict: 'MISMATCH',
      deferredKeys: []
    });
    expect(t.calls.filter((c) => c === 'rerank')).toHaveLength(1);
    expect(t.calls[t.calls.length - 1]).toBe('write');
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

describe('runFollowUpSteps', () => {
  function runner(failing: Partial<Record<ChainDayStep, number>> = {}) {
    const ran: string[] = [];
    const tries: Record<string, number> = {};
    const done: ChainDayStep[] = [];
    const givenUp: ChainDayStep[] = [];
    // In the order of the steps, as the store keeps them.
    const state = () => ({
      done: CHAIN_DAY_STEPS.filter((s) => done.includes(s)),
      givenUp: CHAIN_DAY_STEPS.filter((s) => givenUp.includes(s))
    });
    const r: ChainDayStepRunner = {
      async run(step, day) {
        ran.push(`${step} ${day.cycleDay} ${day.block}`);
        if ((failing[step] ?? 0) > 0) {
          failing[step]!--;
          throw new Error(`${step} failed`);
        }
      },
      async markDone(_d, step) {
        done.push(step);
        return state();
      },
      async recordFailure(_d, step) {
        tries[step] = (tries[step] ?? 0) + 1;
        return tries[step];
      },
      async giveUp(_d, steps) {
        givenUp.push(...steps);
        return state();
      }
    };
    return { r, ran, tries };
  }
  const day = {
    cycleDay: 20737,
    block: 1000,
    stepsDone: [] as readonly ChainDayStep[],
    stepsGivenUp: [] as readonly ChainDayStep[]
  };
  const noAlert = async (title: string) => {
    throw new Error(`unexpected alert: ${title}`);
  };

  it('runs every step once, in order, with the day and its block', async () => {
    const t = runner();
    const out = await runFollowUpSteps(day, t.r, noAlert);
    expect(t.ran).toEqual(CHAIN_DAY_STEPS.map((s) => `${s} 20737 1000`));
    expect(out).toEqual({
      done: [...CHAIN_DAY_STEPS],
      givenUp: [],
      failed: []
    });
  });

  it('counts a failed step and still runs the steps after it', async () => {
    const t = runner({ uploads: 1 });
    const out = await runFollowUpSteps(day, t.r, noAlert);
    expect(out.failed).toEqual(['uploads']);
    expect(out.done).toEqual(['nfts', 'history', 'metrics', 'dayFiles']);
    expect(t.tries).toEqual({ uploads: 1 });
    const again = await runFollowUpSteps(
      { ...day, stepsDone: out.done },
      t.r,
      noAlert
    );
    expect(again.done).toEqual([...CHAIN_DAY_STEPS]);
  });

  it(`gives a step up after ${MAX_STEP_TRIES} failed runs, with an alert`, async () => {
    const t = runner({ metrics: MAX_STEP_TRIES });
    const alerts: string[] = [];
    let state = { ...day };
    for (let i = 0; i < MAX_STEP_TRIES; i++) {
      const out = await runFollowUpSteps(state, t.r, async (title) => {
        alerts.push(title);
      });
      state = { ...state, stepsDone: out.done, stepsGivenUp: out.givenUp };
    }
    expect(alerts).toEqual(['TDH day 20737: the metrics step was given up']);
    expect(state.stepsGivenUp).toEqual(['metrics']);
    const before = t.ran.length;
    await runFollowUpSteps(state, t.r, noAlert);
    expect(t.ran.length).toBe(before);
  });
});
