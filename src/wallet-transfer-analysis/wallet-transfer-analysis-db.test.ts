import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  TRANSACTIONS_TABLE,
  WALLET_TRANSFER_PAIR_DAYS_TABLE,
  WALLET_TRANSFER_WALLET_DAYS_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { buildTransaction } from '@/tests/test.transactions.helpers';
import {
  DAY_MS,
  PairDailySummary,
  REPORT_QUERY_BUDGET_MS,
  WalletDailySummary,
  WalletTransferAnalysisError
} from './types';
import { aggregateTransferBucket } from './aggregate';
import { WalletTransferAnalysisDb } from './wallet-transfer-analysis.db';
import { WalletTransferAnalysisService } from './wallet-transfer-analysis.service';

const address = (digit: string) => `0x${digit.repeat(40)}`;
const hash = (id: number) => `0x${id.toString(16).padStart(64, '0')}`;
const CONTRACT = address('c');
const OTHER_CONTRACT = address('e');
const A = address('1');
const B = address('2');
const C = address('3');
const D = address('4');
const DAY = Date.UTC(2026, 8, 1);
const ctx: RequestContext = {};

function pair(overrides: Partial<PairDailySummary> = {}): PairDailySummary {
  return {
    contract: CONTRACT,
    bucket_start: 1_000,
    day_start: DAY,
    from_address: A,
    to_address: B,
    transfer_count: 2,
    token_count: 3,
    first_transfer_at: DAY + 1_000,
    last_transfer_at: DAY + 2_000,
    sample_transaction: hash(1),
    ...overrides
  };
}

function wallet(
  walletAddress: string,
  overrides: Partial<WalletDailySummary> = {}
): WalletDailySummary {
  return {
    contract: CONTRACT,
    bucket_start: 1_000,
    day_start: DAY,
    wallet: walletAddress,
    outbound_count: 0,
    inbound_count: 0,
    outbound_token_count: 0,
    inbound_token_count: 0,
    ...overrides
  };
}

async function saveBucket(
  repository: WalletTransferAnalysisDb,
  bucketStart: number,
  pairs: PairDailySummary[],
  wallets: WalletDailySummary[],
  contract = CONTRACT
) {
  await repository.inTransaction(async (txCtx) => {
    await repository.lockState(contract, txCtx);
    await repository.replaceBucket(
      contract,
      bucketStart,
      pairs,
      wallets,
      bucketStart + 999,
      txCtx
    );
  }, ctx);
}

async function insertSourceRows(
  rows: (Omit<ReturnType<typeof buildTransaction>, 'transaction_date'> & {
    transaction_date: Date | string;
  })[]
) {
  await sqlExecutor.bulkInsert(TRANSACTIONS_TABLE, rows, Object.keys(rows[0]));
}

describeWithSeed('WalletTransferAnalysisDb', [], () => {
  let repository: WalletTransferAnalysisDb;
  beforeEach(() => {
    repository = new WalletTransferAnalysisDb(() => sqlExecutor);
  });

  it('replaces one bucket without accumulating retries or deleting other buckets and contracts', async () => {
    const initialWallets = [
      wallet(A, { outbound_count: 2, outbound_token_count: 3 }),
      wallet(B, { inbound_count: 2, inbound_token_count: 3 })
    ];
    await saveBucket(repository, 1_000, [pair()], initialWallets);
    await saveBucket(repository, 1_000, [pair()], initialWallets);
    await saveBucket(repository, 2_000, [pair({ bucket_start: 2_000 })], []);
    await saveBucket(
      repository,
      1_000,
      [pair({ contract: OTHER_CONTRACT })],
      [],
      OTHER_CONTRACT
    );

    const correction = pair({ transfer_count: 1, token_count: 1 });
    await saveBucket(
      repository,
      1_000,
      [correction],
      [
        wallet(A, { outbound_count: 1, outbound_token_count: 1 }),
        wallet(B, { inbound_count: 1, inbound_token_count: 1 })
      ]
    );

    const storedPairs = await sqlExecutor.execute<PairDailySummary>(
      `SELECT * FROM ${WALLET_TRANSFER_PAIR_DAYS_TABLE}
       ORDER BY contract, bucket_start`
    );
    expect(storedPairs).toHaveLength(3);
    expect(
      storedPairs.find(
        (row) => row.contract === CONTRACT && row.bucket_start === 1_000
      )
    ).toEqual(correction);
    expect((await repository.getState(CONTRACT, ctx))?.last_block).toBe(2_999);

    const priorState = await repository.getState(CONTRACT, ctx);
    const refreshedAt = priorState!.updated_at + 1_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(refreshedAt);
    try {
      await repository.inTransaction(async (txCtx) => {
        await repository.lockState(CONTRACT, txCtx);
        await repository.replaceBucket(CONTRACT, 1_000, [], [], null, txCtx);
      }, ctx);
    } finally {
      clock.mockRestore();
    }
    expect(
      await sqlExecutor.execute(
        `SELECT * FROM ${WALLET_TRANSFER_WALLET_DAYS_TABLE}
         WHERE contract = :contract AND bucket_start = 1000`,
        { contract: CONTRACT }
      )
    ).toEqual([]);
    expect(
      await sqlExecutor.execute(
        `SELECT * FROM ${WALLET_TRANSFER_PAIR_DAYS_TABLE}`
      )
    ).toHaveLength(2);
    expect(await repository.getState(CONTRACT, ctx)).toEqual({
      contract: CONTRACT,
      last_block: 2_999,
      updated_at: refreshedAt
    });
  });

  it('rolls back both derived changes and the checkpoint on a failed transaction', async () => {
    await saveBucket(repository, 1_000, [pair()], []);
    await expect(
      repository.inTransaction(async (txCtx) => {
        await repository.lockState(CONTRACT, txCtx);
        await repository.replaceBucket(
          CONTRACT,
          1_000,
          [pair({ transfer_count: 9 })],
          [],
          2_999,
          txCtx
        );
        throw new Error('Synthetic downstream failure');
      }, ctx)
    ).rejects.toThrow('Synthetic downstream failure');
    const rows = await sqlExecutor.execute<PairDailySummary>(
      `SELECT * FROM ${WALLET_TRANSFER_PAIR_DAYS_TABLE}`
    );
    expect(rows).toEqual([pair()]);
    expect((await repository.getState(CONTRACT, ctx))?.last_block).toBe(1_999);
    await expect(repository.lockState(CONTRACT, ctx)).rejects.toThrow(
      'require a transaction'
    );
    await expect(
      repository.replaceBucket(CONTRACT, 1_000, [], [], null, ctx)
    ).rejects.toThrow('require a transaction');
  });

  it('rejects summaries from another bucket before deleting any existing data', async () => {
    await saveBucket(repository, 1_000, [pair()], []);
    await expect(
      saveBucket(repository, 1_000, [pair({ bucket_start: 2_000 })], [])
    ).rejects.toThrow('does not belong to this bucket');
    expect(
      await sqlExecutor.execute<PairDailySummary>(
        `SELECT * FROM ${WALLET_TRANSFER_PAIR_DAYS_TABLE}`
      )
    ).toEqual([pair()]);
  });

  it('combines reciprocal directions and exact days before limiting, retaining consolidated-transfer denominators', async () => {
    await saveBucket(
      repository,
      1_000,
      [
        pair(),
        pair({
          from_address: B,
          to_address: A,
          transfer_count: 1,
          token_count: 1,
          sample_transaction: hash(2)
        })
      ],
      [
        wallet(A, { outbound_count: 2, inbound_count: 1 }),
        wallet(B, { outbound_count: 1, inbound_count: 2 })
      ]
    );
    await saveBucket(
      repository,
      2_000,
      [
        pair({ bucket_start: 2_000, transfer_count: 3, token_count: 5 }),
        pair({
          bucket_start: 2_000,
          day_start: DAY + DAY_MS,
          transfer_count: 1,
          token_count: 2,
          first_transfer_at: DAY + DAY_MS + 1_000,
          last_transfer_at: DAY + DAY_MS + 2_000
        }),
        pair({
          bucket_start: 2_000,
          day_start: DAY + DAY_MS,
          from_address: B,
          to_address: A,
          transfer_count: 2,
          token_count: 7,
          first_transfer_at: DAY + DAY_MS + 1_000,
          last_transfer_at: DAY + DAY_MS + 3_000,
          sample_transaction: hash(2)
        }),
        pair({ bucket_start: 2_000, to_address: C, transfer_count: 4 }),
        pair({
          bucket_start: 2_000,
          from_address: C,
          to_address: D,
          transfer_count: 8
        })
      ],
      [
        wallet(A, { bucket_start: 2_000, outbound_count: 7 }),
        wallet(B, { bucket_start: 2_000, inbound_count: 3 }),
        wallet(C, { bucket_start: 2_000, inbound_count: 4, outbound_count: 8 }),
        wallet(D, { bucket_start: 2_000, inbound_count: 8 }),
        wallet(A, {
          bucket_start: 2_000,
          day_start: DAY + DAY_MS,
          outbound_count: 1,
          inbound_count: 2
        }),
        wallet(B, {
          bucket_start: 2_000,
          day_start: DAY + DAY_MS,
          outbound_count: 2,
          inbound_count: 1
        })
      ]
    );
    await saveBucket(
      repository,
      3_000,
      [
        pair({
          bucket_start: 3_000,
          day_start: DAY + 2 * DAY_MS,
          transfer_count: 100,
          first_transfer_at: DAY + 2 * DAY_MS + 1_000,
          last_transfer_at: DAY + 2 * DAY_MS + 2_000
        })
      ],
      [
        wallet(A, {
          bucket_start: 3_000,
          day_start: DAY + 2 * DAY_MS,
          outbound_count: 100
        })
      ]
    );
    await saveBucket(
      repository,
      1_000,
      [pair({ contract: OTHER_CONTRACT, transfer_count: 100 })],
      [],
      OTHER_CONTRACT
    );
    await sqlExecutor.bulkInsert(
      ADDRESS_CONSOLIDATION_KEY,
      [
        { address: A, consolidation_key: `${A}-${C}` },
        { address: C, consolidation_key: `${A}-${C}` }
      ],
      ['address', 'consolidation_key']
    );

    const metrics = await repository.listPairMetrics(
      CONTRACT,
      null,
      DAY + 2 * DAY_MS,
      1,
      ctx
    );
    expect(metrics).toEqual([
      {
        wallet_a: A,
        wallet_b: B,
        a_to_b_count: 6,
        b_to_a_count: 3,
        a_to_b_token_count: 10,
        b_to_a_token_count: 8,
        a_to_b_days: 2,
        b_to_a_days: 2,
        active_days: 2,
        first_transfer_at: DAY + 1_000,
        last_transfer_at: DAY + DAY_MS + 3_000,
        sample_transaction_a_to_b: hash(1),
        sample_transaction_b_to_a: hash(2),
        a_outbound_count: 10,
        a_inbound_count: 3,
        b_outbound_count: 3,
        b_inbound_count: 6
      }
    ]);
    const allPairs = await repository.listPairMetrics(
      CONTRACT,
      null,
      DAY + 2 * DAY_MS,
      10,
      ctx
    );
    expect(allPairs.map((row) => [row.wallet_a, row.wallet_b])).toEqual([
      [A, B],
      [C, D]
    ]);
    const lastDay = await repository.listPairMetrics(
      CONTRACT,
      DAY + DAY_MS,
      DAY + 2 * DAY_MS,
      10,
      ctx
    );
    expect(lastDay).toEqual([
      expect.objectContaining({
        a_to_b_count: 1,
        b_to_a_count: 2,
        active_days: 1,
        a_outbound_count: 1,
        a_inbound_count: 2,
        b_outbound_count: 2,
        b_inbound_count: 1
      })
    ]);
  });

  it('retains unconsolidated pairs with empty keys and reverse-only transfers', async () => {
    await saveBucket(
      repository,
      1_000,
      [pair({ from_address: B, to_address: A })],
      [wallet(B, { outbound_count: 2 }), wallet(A, { inbound_count: 2 })]
    );
    await sqlExecutor.bulkInsert(
      ADDRESS_CONSOLIDATION_KEY,
      [
        { address: A, consolidation_key: '' },
        { address: B, consolidation_key: '' }
      ],
      ['address', 'consolidation_key']
    );
    expect(
      await repository.listPairMetrics(CONTRACT, null, DAY + DAY_MS, 1, ctx)
    ).toEqual([
      expect.objectContaining({
        wallet_a: A,
        wallet_b: B,
        a_to_b_count: 0,
        b_to_a_count: 2,
        a_to_b_days: 0,
        b_to_a_days: 1,
        sample_transaction_a_to_b: null,
        sample_transaction_b_to_a: hash(1)
      })
    ]);
  });

  it('bounds source reads by contract and block, preserves an overflow sentinel, and exposes the existing range index', async () => {
    const sourceRows = [1_001, 1_002, 1_003, 1_004, 2_500].map((block, id) => ({
      ...buildTransaction(A, B, CONTRACT, id + 1, 1, id === 1 ? 2 : 0),
      transaction: hash(id),
      block,
      transaction_date: new Date(DAY)
    }));
    const unrelated = Array.from({ length: 300 }, (_unused, id) => ({
      ...buildTransaction(A, B, OTHER_CONTRACT, id + 1),
      transaction: hash(10 + id),
      block: 1_000 + id,
      transaction_date: new Date(DAY)
    }));
    await insertSourceRows([...sourceRows, ...unrelated]);
    expect(await repository.getSourceBounds(CONTRACT, ctx)).toEqual({
      minBlock: 1_001,
      maxBlock: 2_500
    });
    expect(await repository.getSourceBounds(address('f'), ctx)).toEqual({
      minBlock: null,
      maxBlock: null
    });
    expect(await repository.findNextBlock(CONTRACT, 1_004, 3_000, ctx)).toBe(
      2_500
    );
    expect(
      await repository.findNextBlock(CONTRACT, 1_004, 2_000, ctx)
    ).toBeNull();
    const rows = await repository.loadBucket(CONTRACT, 1_000, 1_999, 2, ctx);
    expect(rows.map((row) => row.block)).toEqual([1_001, 1_002, 1_003]);
    expect(rows[1].value).toBe(2);
    const explanation = await repository.explainSourceBucket(
      CONTRACT,
      1_000,
      1_999,
      2,
      ctx
    );
    expect(explanation).toEqual([
      expect.objectContaining({ key: 'idx_transactions_contract_block' })
    ]);
    await expect(
      repository.loadBucket(CONTRACT, 0, 1_000, 100_001, ctx)
    ).rejects.toThrow('row limit');
    await expect(
      repository.listPairMetrics(CONTRACT, null, DAY, 10_002, ctx)
    ).rejects.toThrow('bounded report size');
  });

  it('preserves UTC wall-clock timestamps through source loading, incremental summaries, and ranked reports', async () => {
    const fixtures = [
      {
        block: 1_001,
        id: 11,
        from: A,
        to: B,
        token: 1,
        quantity: 1,
        date: '2026-09-01 00:00:01',
        value: 0
      },
      {
        block: 1_001,
        id: 11,
        from: A,
        to: B,
        token: 2,
        quantity: 2,
        date: '2026-09-01 00:00:01',
        value: 0
      },
      {
        block: 1_002,
        id: 15,
        from: A,
        to: C,
        token: 1,
        quantity: 5,
        date: '2026-09-01 00:00:02',
        value: 0
      },
      {
        block: 2_001,
        id: 12,
        from: B,
        to: A,
        token: 1,
        quantity: 2,
        date: '2026-09-02 23:59:59',
        value: 0
      },
      {
        block: 3_001,
        id: 13,
        from: A,
        to: B,
        token: 1,
        quantity: 3,
        date: '2026-09-08 00:00:01',
        value: 0
      },
      {
        block: 3_002,
        id: 16,
        from: A,
        to: B,
        token: 1,
        quantity: 6,
        date: '2026-09-08 00:01:00',
        value: 2
      },
      {
        block: 4_001,
        id: 14,
        from: B,
        to: A,
        token: 1,
        quantity: 4,
        date: '2026-09-09 23:59:59',
        value: 0
      }
    ];
    await insertSourceRows(
      fixtures.map((fixture) => ({
        ...buildTransaction(
          fixture.from,
          fixture.to,
          CONTRACT,
          fixture.token,
          fixture.quantity,
          fixture.value
        ),
        block: fixture.block,
        transaction: hash(fixture.id),
        transaction_date: fixture.date
      }))
    );
    const firstBucket = await repository.loadBucket(
      CONTRACT,
      1_000,
      1_999,
      100,
      ctx
    );
    expect(firstBucket.map((row) => row.transaction_date)).toEqual([
      '2026-09-01 00:00:01',
      '2026-09-01 00:00:01',
      '2026-09-01 00:00:02'
    ]);
    expect(
      aggregateTransferBucket(firstBucket, CONTRACT, 1_000).pairs.map(
        (summary) => summary.day_start
      )
    ).toEqual([DAY, DAY]);
    const nearMidnight = await repository.loadBucket(
      CONTRACT,
      2_000,
      2_999,
      100,
      ctx
    );
    expect(nearMidnight[0].transaction_date).toBe('2026-09-02 23:59:59');
    expect(
      aggregateTransferBucket(nearMidnight, CONTRACT, 2_000).pairs[0].day_start
    ).toBe(DAY + DAY_MS);

    const service = new WalletTransferAnalysisService(
      repository,
      () => Date.UTC(2026, 8, 12),
      CONTRACT
    );
    await service.update({ maxBatches: 10, maxRows: 100 });
    const firstReport = await service.report({ days: 30, limit: 10 });
    expect(firstReport.source_block_range_covered).toBe(true);
    expect(firstReport.candidates).toEqual([
      expect.objectContaining({
        wallet_a: A,
        wallet_b: B,
        a_to_b_count: 2,
        b_to_a_count: 2,
        a_to_b_token_count: 6,
        b_to_a_token_count: 6,
        a_to_b_days: 2,
        b_to_a_days: 2,
        active_days: 4,
        a_outbound_count: 3,
        a_inbound_count: 2,
        b_outbound_count: 2,
        b_inbound_count: 2,
        first_transfer_at: Date.parse('2026-09-01T00:00:01Z'),
        last_transfer_at: Date.parse('2026-09-09T23:59:59Z'),
        a_to_b_outbound_share: 2 / 3,
        b_to_a_outbound_share: 1,
        rules: [
          'repeated_reciprocal_transfers',
          'concentrated_outgoing_transfers',
          'persistent_transfer_relationship'
        ]
      })
    ]);
    await service.update({ maxBatches: 10, maxRows: 100 });
    const secondReport = await service.report({ days: 30, limit: 10 });
    expect(secondReport.candidates).toEqual(firstReport.candidates);
    expect(secondReport.summary_state?.last_block).toBe(4_999);
  });

  it('keeps the report execution-time hint in the MySQL optimized CTE statement', async () => {
    await saveBucket(repository, 1_000, [pair()], []);
    await repository.inTransaction(async (txCtx) => {
      const executed = jest.spyOn(sqlExecutor, 'execute');
      let reportCall: Parameters<typeof sqlExecutor.execute> | undefined;
      try {
        await repository.listPairMetrics(
          CONTRACT,
          null,
          DAY + DAY_MS,
          10,
          txCtx
        );
        reportCall = executed.mock.calls.find(([sql]) =>
          sql.startsWith('WITH pair_totals')
        );
      } finally {
        executed.mockRestore();
      }
      expect(reportCall).toBeDefined();
      const queryOptions = { wrappedConnection: txCtx.connection };
      const queryWarnings = await sqlExecutor.execute<{
        Level: string;
        Message: string;
      }>('SHOW WARNINGS', undefined, queryOptions);
      expect(
        queryWarnings.filter((warning) => warning.Level !== 'Note')
      ).toEqual([]);
      await sqlExecutor.execute(
        `EXPLAIN ${reportCall![0]}`,
        reportCall![1],
        queryOptions
      );
      const explainWarnings = await sqlExecutor.execute<{
        Level: string;
        Message: string;
      }>('SHOW WARNINGS', undefined, queryOptions);
      expect(
        explainWarnings.filter((warning) => warning.Level !== 'Note')
      ).toEqual([]);
      expect(
        explainWarnings.some((warning) =>
          warning.Message.includes(
            `MAX_EXECUTION_TIME(${REPORT_QUERY_BUDGET_MS})`
          )
        )
      ).toBe(true);
    }, ctx);
  });

  it.each([{ code: 'ER_QUERY_TIMEOUT' }, { errno: 3024 }])(
    'converts report timeout %j into an operator message without query details',
    async (timeout) => {
      const execute = jest.spyOn(sqlExecutor, 'execute').mockRejectedValueOnce({
        ...timeout,
        sql: 'private query text',
        message: 'private database error details'
      });
      try {
        const result = repository.listPairMetrics(
          CONTRACT,
          null,
          DAY + DAY_MS,
          10,
          ctx
        );
        await expect(result).rejects.toBeInstanceOf(
          WalletTransferAnalysisError
        );
        await expect(result).rejects.toThrow(
          `Report exceeded its ${REPORT_QUERY_BUDGET_MS} ms database budget; try a narrower report window`
        );
      } finally {
        execute.mockRestore();
      }
    }
  );
});
