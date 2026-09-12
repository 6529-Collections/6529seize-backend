import { MEMES_CONTRACT } from '@/constants';
import { RequestContext } from '@/request.context';
import {
  AnalysisState,
  DAY_MS,
  PairDailySummary,
  PairMetrics,
  SourceTransfer,
  TransferAnalysisStore,
  WalletDailySummary
} from './types';
import {
  WalletTransferAnalysisError,
  WalletTransferAnalysisService
} from './wallet-transfer-analysis.service';

jest.mock('./wallet-transfer-analysis.db', () => ({
  WalletTransferAnalysisDb: jest.fn()
}));

jest.mock('@/sql-executor', () => ({ dbSupplier: jest.fn() }));

const CONTRACT = MEMES_CONTRACT.toLowerCase();
const WALLET_A = `0x${'a'.repeat(40)}`;
const WALLET_B = `0x${'b'.repeat(40)}`;
const NOW = Date.parse('2026-09-12T16:30:00Z');

function transfer(
  block: number,
  overrides: Partial<SourceTransfer> = {}
): SourceTransfer {
  return {
    transaction: `transaction-${block}`,
    block,
    transaction_date: '2026-09-10T12:00:00Z',
    from_address: WALLET_A,
    to_address: WALLET_B,
    contract: CONTRACT,
    token_id: 1,
    token_count: 1,
    value: 0,
    ...overrides
  };
}

function pairMetrics(overrides: Partial<PairMetrics> = {}): PairMetrics {
  return {
    wallet_a: WALLET_A,
    wallet_b: WALLET_B,
    a_to_b_count: 4,
    b_to_a_count: 0,
    a_to_b_token_count: 10,
    b_to_a_token_count: 0,
    a_to_b_days: 3,
    b_to_a_days: 0,
    active_days: 3,
    first_transfer_at: NOW - 14 * DAY_MS,
    last_transfer_at: NOW - DAY_MS,
    sample_transaction_a_to_b: 'transfer-evidence',
    sample_transaction_b_to_a: null,
    a_outbound_count: 4,
    a_inbound_count: 0,
    b_outbound_count: 0,
    b_inbound_count: 4,
    ...overrides
  };
}

class MemoryTransferAnalysisStore implements TransferAnalysisStore {
  source: SourceTransfer[] = [];
  state: AnalysisState | null = null;
  pairs = new Map<number, PairDailySummary[]>();
  wallets = new Map<number, WalletDailySummary[]>();
  metrics: PairMetrics[] = [];
  loads: { start: number; end: number; maxRows: number }[] = [];
  replacements: { bucketStart: number; advanceToBlock: number | null }[] = [];
  metricQueries: {
    contract: string;
    fromDay: number | null;
    toDayExclusive: number;
    limit: number;
  }[] = [];
  failReplacementAt: number | null = null;
  afterSourceBounds?: () => void;
  private transactionOpen = false;

  async inTransaction<T>(
    work: (ctx: RequestContext) => Promise<T>,
    ctx: RequestContext
  ): Promise<T> {
    const originalState = this.state ? { ...this.state } : null;
    const originalPairs = new Map(this.pairs);
    const originalWallets = new Map(this.wallets);
    this.transactionOpen = true;
    try {
      return await work(ctx);
    } catch (error) {
      this.state = originalState;
      this.pairs = originalPairs;
      this.wallets = originalWallets;
      throw error;
    } finally {
      this.transactionOpen = false;
    }
  }

  async lockState(contract: string): Promise<AnalysisState> {
    expect(this.transactionOpen).toBe(true);
    this.state ??= { contract, last_block: -1, updated_at: NOW };
    return { ...this.state };
  }

  async getState(): Promise<AnalysisState | null> {
    return this.state ? { ...this.state } : null;
  }

  async getSourceBounds() {
    const blocks = this.source.map((row) => row.block);
    const bounds = {
      minBlock: blocks.length ? Math.min(...blocks) : null,
      maxBlock: blocks.length ? Math.max(...blocks) : null
    };
    this.afterSourceBounds?.();
    return bounds;
  }

  async findNextBlock(
    contract: string,
    afterBlock: number,
    toBlock: number
  ): Promise<number | null> {
    const blocks = this.source
      .filter((row) => row.block > afterBlock && row.block <= toBlock)
      .map((row) => row.block);
    return blocks.length ? Math.min(...blocks) : null;
  }

  async loadBucket(
    contract: string,
    start: number,
    end: number,
    maxRows: number
  ): Promise<SourceTransfer[]> {
    expect(this.transactionOpen).toBe(true);
    this.loads.push({ start, end, maxRows });
    return this.source
      .filter((row) => row.block >= start && row.block <= end)
      .slice(0, maxRows + 1);
  }

  async replaceBucket(
    contract: string,
    bucketStart: number,
    pairs: PairDailySummary[],
    wallets: WalletDailySummary[],
    advanceToBlock: number | null
  ): Promise<void> {
    expect(this.transactionOpen).toBe(true);
    this.replacements.push({ bucketStart, advanceToBlock });
    this.pairs.set(bucketStart, pairs);
    this.wallets.set(bucketStart, wallets);
    if (advanceToBlock !== null) {
      this.state = {
        contract,
        last_block: Math.max(this.state?.last_block ?? -1, advanceToBlock),
        updated_at: NOW
      };
    }
    if (this.failReplacementAt === bucketStart) {
      throw new Error('Injected replacement failure');
    }
  }

  async listPairMetrics(
    contract: string,
    fromDay: number | null,
    toDayExclusive: number,
    limit: number
  ): Promise<PairMetrics[]> {
    expect(this.transactionOpen).toBe(true);
    this.metricQueries.push({ contract, fromDay, toDayExclusive, limit });
    return this.metrics.slice(0, limit);
  }

  async explainSourceBucket(): Promise<Record<string, unknown>[]> {
    return [{ key: 'contract_block', type: 'range' }];
  }
}

describe('WalletTransferAnalysisService incremental updates', () => {
  let store: MemoryTransferAnalysisStore;
  let service: WalletTransferAnalysisService;

  beforeEach(() => {
    store = new MemoryTransferAnalysisStore();
    service = new WalletTransferAnalysisService(store, () => NOW, CONTRACT);
  });

  it('leaves an empty source without a fabricated processed checkpoint', async () => {
    const result = await service.update({ maxBatches: 1, maxRows: 100 });

    expect(result.source_max_block).toBeNull();
    expect(result.refreshed_buckets).toEqual([]);
    expect(store.state).toBeNull();
    expect(store.loads).toEqual([]);
  });

  it('starts without a checkpoint and jumps over empty block ranges', async () => {
    store.source = [transfer(2_020), transfer(9_500)];

    await service.update({ maxBatches: 2, maxRows: 100 });

    expect(store.loads).toEqual([
      { start: 2_000, end: 2_999, maxRows: 100 },
      { start: 9_000, end: 9_999, maxRows: 100 }
    ]);
    expect(store.state?.last_block).toBe(9_999);
    expect(store.pairs.get(2_000)?.[0].transfer_count).toBe(1);
  });

  it('counts a multi-card transaction as one pair episode and sums its units', async () => {
    store.source = [
      transfer(1_005, { token_id: 1, token_count: 2 }),
      transfer(1_005, { token_id: 2, token_count: 3 })
    ];

    await service.update({ maxBatches: 1, maxRows: 100 });

    expect(store.pairs.get(1_000)).toEqual([
      expect.objectContaining({ transfer_count: 1, token_count: 5 })
    ]);
    expect(store.wallets.get(1_000)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ wallet: WALLET_A, outbound_count: 1 }),
        expect.objectContaining({ wallet: WALLET_B, inbound_count: 1 })
      ])
    );
  });

  it('reconciles the last bucket after restart without duplicating its counts', async () => {
    store.source = [transfer(1_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });

    const restarted = new WalletTransferAnalysisService(
      store,
      () => NOW,
      CONTRACT
    );
    await restarted.update({ maxBatches: 1, maxRows: 100 });

    expect(store.pairs.get(1_000)?.[0].transfer_count).toBe(1);
    expect(store.state?.last_block).toBe(1_999);
    expect(store.loads).toHaveLength(2);
  });

  it('reconciles additions in the same block and later in the last bucket', async () => {
    store.source = [transfer(1_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });
    store.source.push(
      transfer(1_005, { transaction: 'second-in-same-block' }),
      transfer(1_006)
    );

    await service.update({ maxBatches: 1, maxRows: 100 });

    expect(store.pairs.get(1_000)?.[0].transfer_count).toBe(3);
    expect(store.state?.last_block).toBe(1_999);
  });

  it('removes corrected sale rows from both pair and wallet denominators', async () => {
    store.source = [transfer(1_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });
    store.source[0] = transfer(1_005, { value: 0.2 });

    await service.update({ maxBatches: 1, maxRows: 100 });

    expect(store.pairs.get(1_000)).toEqual([]);
    expect(store.wallets.get(1_000)).toEqual([]);
    expect(store.state?.last_block).toBe(1_999);
  });

  it('makes forward progress with maxBatches one in addition to reconciliation', async () => {
    store.source = [transfer(1_005), transfer(3_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });
    store.loads = [];

    await service.update({ maxBatches: 1, maxRows: 100 });

    expect(store.loads.map((load) => load.start)).toEqual([1_000, 3_000]);
    expect(store.state?.last_block).toBe(3_999);
  });

  it('does not chase new source blocks beyond the invocation high-water mark', async () => {
    store.source = [transfer(1_005)];
    store.afterSourceBounds = () => store.source.push(transfer(8_005));

    await service.update({ maxBatches: 5, maxRows: 100 });

    expect(store.loads.map((load) => load.start)).toEqual([1_000]);
    expect(store.state?.last_block).toBe(1_999);
  });

  it('rejects overflow without publishing a partial bucket or skipping it', async () => {
    store.source = [transfer(1_005)];
    await service.update({ maxBatches: 1, maxRows: 2 });
    store.source.push(transfer(3_001), transfer(3_002), transfer(3_003));

    await expect(service.update({ maxBatches: 1, maxRows: 2 })).rejects.toThrow(
      WalletTransferAnalysisError
    );

    expect(store.state?.last_block).toBe(1_999);
    expect(store.pairs.has(3_000)).toBe(false);

    await service.update({ maxBatches: 1, maxRows: 3 });
    expect(store.state?.last_block).toBe(3_999);
    expect(store.pairs.get(3_000)?.[0].transfer_count).toBe(3);
  });

  it('preserves the prior summary when reconciliation exceeds the row cap', async () => {
    store.source = [transfer(1_005)];
    await service.update({ maxBatches: 1, maxRows: 1 });
    store.source.push(transfer(1_006));

    await expect(service.update({ maxBatches: 1, maxRows: 1 })).rejects.toThrow(
      WalletTransferAnalysisError
    );

    expect(store.state?.last_block).toBe(1_999);
    expect(store.pairs.get(1_000)?.[0].transfer_count).toBe(1);
  });

  it('rolls back summary replacement and checkpoint together on write failure', async () => {
    store.source = [transfer(1_005), transfer(3_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });
    store.failReplacementAt = 3_000;

    await expect(
      service.update({ maxBatches: 1, maxRows: 100 })
    ).rejects.toThrow('Injected replacement failure');

    expect(store.state?.last_block).toBe(1_999);
    expect(store.pairs.has(3_000)).toBe(false);
    expect(store.wallets.has(3_000)).toBe(false);
    store.failReplacementAt = null;
    await service.update({ maxBatches: 1, maxRows: 100 });
    expect(store.state?.last_block).toBe(3_999);
  });

  it.each([0, 51, 1.5, Number.NaN])(
    'rejects an invalid forward batch budget %s before reading source buckets',
    async (maxBatches) => {
      store.source = [transfer(1_005)];

      await expect(
        service.update({ maxBatches, maxRows: 100 })
      ).rejects.toThrow(WalletTransferAnalysisError);

      expect(store.loads).toEqual([]);
      expect(store.state).toBeNull();
    }
  );

  it.each([0, 100_001, 1.5, Number.NaN])(
    'rejects an invalid source row cap %s before reading source buckets',
    async (maxRows) => {
      store.source = [transfer(1_005)];

      await expect(service.update({ maxBatches: 1, maxRows })).rejects.toThrow(
        WalletTransferAnalysisError
      );

      expect(store.loads).toEqual([]);
      expect(store.state).toBeNull();
    }
  );
});

describe('WalletTransferAnalysisService bounded rebuilds', () => {
  let store: MemoryTransferAnalysisStore;
  let service: WalletTransferAnalysisService;

  beforeEach(() => {
    store = new MemoryTransferAnalysisStore();
    service = new WalletTransferAnalysisService(store, () => NOW, CONTRACT);
  });

  it('expands an interior range to whole buckets without advancing its checkpoint', async () => {
    store.source = [transfer(1_005), transfer(1_900), transfer(3_005)];
    await service.update({ maxBatches: 2, maxRows: 100 });
    store.source[0] = transfer(1_005, { value: 2 });
    store.loads = [];
    store.replacements = [];

    await service.rebuild({
      fromBlock: 1_200,
      toBlock: 1_300,
      maxRows: 100
    });

    expect(store.loads).toEqual([{ start: 1_000, end: 1_999, maxRows: 100 }]);
    expect(store.pairs.get(1_000)?.[0].transfer_count).toBe(1);
    expect(store.replacements).toEqual([
      { bucketStart: 1_000, advanceToBlock: null }
    ]);
    expect(store.state?.last_block).toBe(3_999);
  });

  it('requires an existing processed checkpoint before rebuilding', async () => {
    store.source = [transfer(1_005)];

    await expect(
      service.rebuild({ fromBlock: 1_005, toBlock: 1_005, maxRows: 100 })
    ).rejects.toThrow(WalletTransferAnalysisError);

    expect(store.loads).toEqual([]);
    expect(store.state).toBeNull();
  });

  it('rejects a range extending into an unprocessed bucket before changing summaries', async () => {
    store.source = [transfer(1_005), transfer(3_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });
    store.loads = [];

    await expect(
      service.rebuild({ fromBlock: 1_005, toBlock: 2_000, maxRows: 100 })
    ).rejects.toThrow(WalletTransferAnalysisError);

    expect(store.loads).toEqual([]);
    expect(store.state?.last_block).toBe(1_999);
  });

  it('rejects more than fifty intersecting buckets, including partial endpoints', async () => {
    store.state = { contract: CONTRACT, last_block: 99_999, updated_at: NOW };

    await expect(
      service.rebuild({ fromBlock: 999, toBlock: 50_000, maxRows: 100 })
    ).rejects.toThrow(WalletTransferAnalysisError);

    expect(store.loads).toEqual([]);
  });
});

describe('WalletTransferAnalysisService reports', () => {
  let store: MemoryTransferAnalysisStore;
  let service: WalletTransferAnalysisService;

  beforeEach(() => {
    store = new MemoryTransferAnalysisStore();
    service = new WalletTransferAnalysisService(store, () => NOW, CONTRACT);
  });

  it.each([30, 90, 365, null] as const)(
    'reads %s days of UTC summaries including the current day',
    async (days) => {
      const toDayExclusive = Date.parse('2026-09-13T00:00:00Z');

      const report = await service.report({ days, limit: 100 });

      expect(store.metricQueries).toEqual([
        {
          contract: CONTRACT,
          fromDay: days === null ? null : toDayExclusive - days * DAY_MS,
          toDayExclusive,
          limit: 10_001
        }
      ]);
      expect(report.generated_at).toBe(NOW);
      expect(store.loads).toEqual([]);
      expect(store.replacements).toEqual([]);
      expect(store.state).toBeNull();
    }
  );

  it('exposes a missing checkpoint when source history has not been processed', async () => {
    store.source = [transfer(1_005)];

    const report = await service.report({ days: 90, limit: 100 });

    expect(report.summary_state).toBeNull();
    expect(report.source_block_range_covered).toBe(false);
    expect(report.source_max_block).toBe(1_005);
    expect(report.candidates).toEqual([]);
  });

  it('discloses the processed checkpoint and source coverage before and after advancing', async () => {
    store.source = [transfer(1_005), transfer(3_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });

    const behind = await service.report({ days: 90, limit: 100 });

    expect(behind.summary_state?.last_block).toBe(1_999);
    expect(behind.source_max_block).toBe(3_005);
    expect(behind.source_block_range_covered).toBe(false);

    await service.update({ maxBatches: 1, maxRows: 100 });
    const advanced = await service.report({ days: 90, limit: 100 });
    expect(advanced.summary_state?.last_block).toBe(3_999);
    expect(advanced.source_block_range_covered).toBe(true);
  });

  it('does not describe block-range coverage as proof that changed rows are fresh', async () => {
    store.source = [transfer(1_005)];
    await service.update({ maxBatches: 1, maxRows: 100 });
    store.source.push(transfer(1_006));

    const report = await service.report({ days: 90, limit: 100 });

    expect(report.source_block_range_covered).toBe(true);
    expect(store.pairs.get(1_000)?.[0].transfer_count).toBe(1);
    expect(report.freshness_note).toContain(
      'Block-range coverage does not detect changed rows'
    );
    expect(report.freshness_note).toContain('latest processed bucket');
    expect(report.freshness_note).toContain('older corrections');
  });

  it('discloses truncated preselection and ranks only the bounded candidate set', async () => {
    store.metrics = Array.from({ length: 10_000 }, (_, index) =>
      pairMetrics({ wallet_b: `0xb${index.toString(16).padStart(39, '0')}` })
    );
    const beyondPreselection = `0x${'f'.repeat(40)}`;
    store.metrics.push(
      pairMetrics({
        wallet_b: beyondPreselection,
        a_to_b_count: 100,
        a_to_b_days: 30,
        active_days: 30,
        first_transfer_at: NOW - 30 * DAY_MS,
        a_outbound_count: 100,
        b_inbound_count: 100
      })
    );

    const report = await service.report({ days: 90, limit: 3 });

    expect(report.preselection_truncated).toBe(true);
    expect(report.candidate_scan_limit).toBe(10_000);
    expect(report.preselection).toContain('highest total transfer occasions');
    expect(report.score_meaning).toContain('not ownership probability');
    expect(report.candidates).toHaveLength(3);
    expect(
      report.candidates.map((candidate) => candidate.wallet_b)
    ).not.toContain(beyondPreselection);
  });

  it('reports an untruncated set and honors the requested output limit', async () => {
    store.metrics = [pairMetrics()];

    const report = await service.report({ days: null, limit: 1 });

    expect(report.preselection_truncated).toBe(false);
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toEqual(
      expect.objectContaining({
        wallet_a: WALLET_A,
        wallet_b: WALLET_B,
        a_to_b_outbound_share: 1,
        sample_transaction_a_to_b: 'transfer-evidence'
      })
    );
  });
});
