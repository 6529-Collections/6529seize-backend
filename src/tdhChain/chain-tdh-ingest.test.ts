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
  ingestChainDay
} from './chain-tdh-ingest';
import { SaveTdhChainDay } from './tdh-chain-days.db';
import { TdhChainDay } from './tdh-chain.types';

const X = `${fixtureWallet('1')}-${fixtureWallet('3')}`;

function deps(
  opts: {
    computed?: SiteFixture;
    live?: SiteFixture;
    width?: number;
    ethHash?: string;
  } = {}
) {
  const day = chainDayFixture();
  const saved: SaveTdhChainDay[] = [];
  const written: ChainTdhRows[] = [];
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
    async readLive() {
      calls.push('live');
      return siteFixtureRows(opts.live ?? siteFixture());
    },
    async write(rows) {
      calls.push('write');
      written.push(rows);
    },
    keyWidth: async () => opts.width ?? 200,
    async saveDay(s) {
      saved.push(s);
    },
    now: () => 42
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
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0].status).toBe('FAILED');
    expect(t.written).toEqual([]);
  });

  it('records a cutoff block that Ethereum disagrees with as FAILED', async () => {
    const t = deps({ ethHash: `0x${'0'.repeat(64)}` });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.status).toBe('FAILED');
    expect(r.summary.failures.map((f) => f.check)).toEqual(['ETH_CUTOFF']);
  });

  it('in SHADOW compares the chain with the computation and the live tables, and writes no TDH table', async () => {
    const t = deps();
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.status).toBe('INGESTED');
    expect(r.verdict).toBe('MATCH');
    expect(t.calls).toEqual([
      `compute ${t.day.header.cutoffNumber} ${t.day.header.cutoffTimestamp * 1000} 2`,
      'consolidate 6',
      'live'
    ]);
    expect(t.written).toEqual([]);
    expect(t.saved[0]).toMatchObject({
      mode: 'SHADOW',
      status: 'INGESTED',
      verdict: 'MATCH'
    });
    expect(r.summary.rowDiff!.wallets.byField).toEqual({});
    expect(r.summary.cache!.verdict).toBe('MATCH');
  });

  it('in SHADOW reports a live table that differs from the chain', async () => {
    const live = siteFixture();
    live.wallets[fixtureWallet('2')].boostedTdh = 251;
    const t = deps({ live });
    const r = await ingestChainDay(t.day, 'SHADOW', t.d);
    expect(r.verdict).toBe('MISMATCH');
    expect(r.summary.live!.counts).toEqual({ WALLET_TDH: 1 });
    expect(r.summary.rowDiff!.wallets.byField).toEqual({ boosted_tdh: 1 });
  });

  it('in CHAIN writes the chain values over a differing computation and ranks again', async () => {
    const computed = siteFixture();
    computed.wallets[fixtureWallet('3')].boostedTdh = 401;
    const t = deps({ computed });
    const r = await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(r).toMatchObject({
      status: 'INGESTED',
      verdict: 'MISMATCH',
      deferredKeys: []
    });
    expect(t.calls).toContain('rerank');
    expect(t.calls).toContain('write');
    expect(t.calls).not.toContain('live');
    const w = t.written[0];
    expect(
      w.wallets.tdh.find((x) => x.wallet === fixtureWallet('3'))!.boosted_tdh
    ).toBe(400);
    expect(
      w.consolidated.every((c) => c.date.getTime() === t.day.apply.applyTimeMs)
    ).toBe(true);
    expect(t.saved[0]).toMatchObject({
      mode: 'CHAIN',
      status: 'INGESTED',
      verdict: 'MISMATCH'
    });
  });

  it('in CHAIN leaves out consolidations whose key is too wide and queues them', async () => {
    const t = deps({ width: 50 });
    const r = await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(r.status).toBe('KEYS_DEFERRED');
    expect(r.deferredKeys).toEqual([X]);
    expect(
      t.written[0].consolidated.map((c) => c.consolidation_key)
    ).not.toContain(X);
    expect(t.written[0].consolidated).toHaveLength(4);
    expect(t.written[0].wallets.tdh).toHaveLength(6);
    expect(t.saved[0]).toMatchObject({
      status: 'KEYS_DEFERRED',
      deferredKeys: [X]
    });
  });

  it('does not rank again when nothing changed', async () => {
    const t = deps();
    await ingestChainDay(t.day, 'CHAIN', t.d);
    expect(t.calls).not.toContain('rerank');
  });
});
