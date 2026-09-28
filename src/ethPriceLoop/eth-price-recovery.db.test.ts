jest.mock('./coinbase', () => ({
  ...jest.requireActual('./coinbase'),
  fetchLivePrice: jest.fn(),
  fetchHistoricPrices: jest.fn()
}));
jest.mock('./eth-price-batch-size', () => ({
  getHistoryChunkMs: jest.fn(),
  growHistoryChunk: jest.fn(),
  shrinkHistoryChunk: jest.fn()
}));
jest.mock('./eth-price-unavailable', () => ({
  getUnavailablePrices: jest.fn(),
  deferMissingPrices: jest.fn()
}));
jest.mock('./eth-price-reset', () => ({
  getPriceReset: jest.fn(),
  savePriceReset: jest.fn()
}));
import { syncEthUsdPrice } from './eth_usd_price';
import { getHistoryChunkMs, growHistoryChunk } from './eth-price-batch-size';
import {
  getUnavailablePrices,
  deferMissingPrices
} from './eth-price-unavailable';
import { getPriceReset } from './eth-price-reset';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import {
  ETH_PRICE_TABLE,
  TRANSACTIONS_TABLE,
  MEMES_MINT_STATS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  MEMES_MINT_PRICE
} from '@/constants';
import { Transaction } from '@/entities/ITransaction';
import {
  EthPriceRecoveryDb,
  ethPriceRecoveryDb
} from './eth-price-recovery.db';
import { EthPriceRepairError } from './eth-price-failure';
import { TransactionsDiscoveryDb } from '@/transactions/transactions.discovery.db';
import { refreshTransactionUsdAtWrite } from '@/eth-prices/transaction-usd';
import {
  HISTORY_START_MS,
  DAILY_PRICE_INTERVAL_MS,
  FIVE_MINUTE_HISTORY_START_MS,
  PRICE_INTERVAL_MS,
  fetchLivePrice,
  fetchHistoricPrices
} from './coinbase';
import { RequestContext } from '@/request.context';
const base = Date.UTC(2026, 8, 28, 12);
const sample = (timestamp_ms: number, usd_price: number) => ({
  timestamp_ms,
  date: new Date(timestamp_ms),
  usd_price
});
function tx(id: string, timestamp: number): Transaction {
  return {
    created_at: new Date(base),
    transaction: id,
    block: 1,
    transaction_date: new Date(timestamp),
    from_address: NULL_ADDRESS,
    to_address: '0x1111111111111111111111111111111111111111',
    contract: MEMES_CONTRACT,
    token_id: 1,
    token_count: 1,
    value: 2,
    primary_proceeds: 2,
    royalties: 0,
    gas_gwei: 0,
    gas_price: 0,
    gas_price_gwei: 0,
    gas: 0.1,
    eth_price_usd: 100,
    value_usd: 200,
    gas_usd: 10
  };
}
async function putTx(row: Transaction, ctx: RequestContext = {}) {
  await sqlExecutor.bulkInsert(
    TRANSACTIONS_TABLE,
    [
      {
        ...row,
        transaction_date: row.transaction_date
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ')
      }
    ],
    Object.keys(row),
    ctx
  );
}
async function putPrice(timestamp: number, usd: number) {
  await sqlExecutor.execute(
    `INSERT INTO ${ETH_PRICE_TABLE} (timestamp_ms,date,usd_price) VALUES (:timestamp_ms,:date,:usd_price)`,
    sample(timestamp, usd)
  );
}
async function readTx(id: string) {
  return sqlExecutor.oneOrNull<Transaction>(
    `SELECT * FROM ${TRANSACTIONS_TABLE} WHERE transaction = :id`,
    { id }
  );
}
async function putStats() {
  await sqlExecutor.execute(
    `INSERT INTO ${MEMES_MINT_STATS_TABLE}
    (id,mint_date,mint_count,direct_mint_count,subscriptions_count,proceeds_eth,proceeds_usd,artist_split_eth,artist_split_usd,payment_details)
    VALUES (1,:date,1,1,0,7,999,3.5,499.5,NULL)`,
    { date: new Date(base) }
  );
}
let repo: EthPriceRecoveryDb;
describeWithSeed('ETH price recovery database', [], () => {
  beforeEach(() => {
    repo = new EthPriceRecoveryDb(() => sqlExecutor);
  });
  // Only provider/checkpoint state is mocked: discovery, inserts and transaction
  // correction all execute against MySQL through the actual collector flow.
  function prepareCollector(now: number, prefixEnd: number) {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    jest
      .spyOn(ethPriceRecoveryDb, 'findGaps')
      .mockImplementation(repo.findGaps.bind(repo));
    jest
      .spyOn(ethPriceRecoveryDb, 'findDailyGaps')
      .mockImplementation(repo.findDailyGaps.bind(repo));
    jest
      .spyOn(ethPriceRecoveryDb, 'saveLive')
      .mockImplementation(repo.saveLive.bind(repo));
    jest
      .spyOn(ethPriceRecoveryDb, 'repair')
      .mockImplementation(repo.repair.bind(repo));
    jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
    jest.mocked(growHistoryChunk).mockImplementation(async (size) => size);
    jest.mocked(getPriceReset).mockResolvedValue(null);
    jest.mocked(deferMissingPrices).mockResolvedValue(undefined);
    jest.mocked(fetchLivePrice).mockResolvedValue(sample(now, 2700));
    const prefix = {
      first: FIVE_MINUTE_HISTORY_START_MS,
      last: prefixEnd,
      retryAt: now + 86400_000
    };
    jest
      .mocked(getUnavailablePrices)
      .mockImplementation(async (_now, interval) =>
        interval === DAILY_PRICE_INTERVAL_MS
          ? [
              {
                first: HISTORY_START_MS,
                last: FIVE_MINUTE_HISTORY_START_MS - DAILY_PRICE_INTERVAL_MS,
                retryAt: now + 86400_000
              }
            ]
          : [prefix]
      );
    return prefix;
  }

  it.each([false, true])(
    'restores three deleted closes in one invocation and resumes committed progress after a lock failure: %s',
    async (interrupt) => {
      const start = Date.UTC(2026, 8, 28, 9, 5);
      const now = Date.UTC(2026, 8, 28, 9, 26, 24);
      const prices = [
        sample(1790586600000, 2636.37),
        sample(1790586900000, 2647.17),
        sample(1790587200000, 2650.97)
      ];
      await putPrice(start, 2643.48);
      await putPrice(1790587500000, 2648.02);
      for (const price of prices) {
        await putPrice(price.timestamp_ms, price.usd_price);
        await putTx(
          tx(`deleted-${price.timestamp_ms}`, price.timestamp_ms + 120_000)
        );
      }
      await sqlExecutor.execute(
        `DELETE FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms IN (:timestamps)`,
        { timestamps: prices.map((price) => price.timestamp_ms) }
      );
      prepareCollector(now, start - PRICE_INTERVAL_MS);
      jest
        .mocked(fetchHistoricPrices)
        .mockImplementation(async (first, last) =>
          prices.filter(
            (price) => price.timestamp_ms >= first && price.timestamp_ms <= last
          )
        );
      try {
        if (interrupt) {
          jest
            .mocked(ethPriceRecoveryDb.repair)
            .mockImplementationOnce(repo.repair.bind(repo))
            .mockRejectedValueOnce(
              Object.assign(new Error('locked'), {
                code: 'ER_LOCK_WAIT_TIMEOUT'
              })
            );
          await expect(syncEthUsdPrice(false)).rejects.toThrow(
            'incomplete work'
          );
          const saved = await sqlExecutor.execute<{ timestamp_ms: number }>(
            `SELECT timestamp_ms FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms IN (:timestamps)`,
            { timestamps: prices.map((price) => price.timestamp_ms) }
          );
          expect(saved.map((row) => Number(row.timestamp_ms))).toEqual([
            1790587200000
          ]);
        }
        await syncEthUsdPrice(false);
        expect(fetchHistoricPrices).toHaveBeenNthCalledWith(
          1,
          1790586600000,
          1790587200000
        );
        if (interrupt)
          expect(fetchHistoricPrices).toHaveBeenNthCalledWith(
            2,
            1790586600000,
            1790586900000
          );
        for (const restored of prices) {
          expect(
            await readTx(`deleted-${restored.timestamp_ms}`)
          ).toMatchObject({
            eth_price_usd: restored.usd_price,
            value_usd: restored.usd_price * 2,
            gas_usd: expect.closeTo(restored.usd_price * 0.1, 6)
          });
        }
        const rows = await sqlExecutor.execute<{
          timestamp_ms: number;
          usd_price: number;
        }>(
          `SELECT timestamp_ms, usd_price FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms > :start AND timestamp_ms <= :end ORDER BY timestamp_ms`,
          { start, end: 1790587500000 }
        );
        expect(
          rows.map((row) => ({
            ...row,
            timestamp_ms: Number(row.timestamp_ms)
          }))
        ).toEqual([
          ...prices.map(({ timestamp_ms, usd_price }) => ({
            timestamp_ms,
            usd_price
          })),
          { timestamp_ms: 1790587500000, usd_price: 2648.02 }
        ]);
        await syncEthUsdPrice(false);
        expect(fetchHistoricPrices).toHaveBeenCalledTimes(interrupt ? 2 : 1);
        expect(ethPriceRecoveryDb.saveLive).toHaveBeenCalledTimes(
          interrupt ? 3 : 2
        );
      } finally {
        jest.restoreAllMocks();
      }
    }
  );

  it('recovers the close immediately before a cooldown without fetching excluded closes', async () => {
    const now = base + 26 * 60_000;
    await putPrice(base, 100);
    await putPrice(base + 25 * 60_000, 200);
    const prefix = prepareCollector(now, base - PRICE_INTERVAL_MS);
    jest
      .mocked(getUnavailablePrices)
      .mockImplementation(async (_now, interval) =>
        interval === DAILY_PRICE_INTERVAL_MS
          ? [
              {
                first: HISTORY_START_MS,
                last: FIVE_MINUTE_HISTORY_START_MS - DAILY_PRICE_INTERVAL_MS,
                retryAt: now + 86400_000
              }
            ]
          : [
              prefix,
              {
                first: base + 15 * 60_000,
                last: base + 20 * 60_000,
                retryAt: now + 86400_000
              }
            ]
      );
    jest
      .mocked(fetchHistoricPrices)
      .mockImplementation(async (first, last) => [
        sample(first, 150),
        sample(last, 160)
      ]);
    try {
      await syncEthUsdPrice(false);
      expect(fetchHistoricPrices).toHaveBeenNthCalledWith(
        1,
        base + 5 * 60_000,
        base + 10 * 60_000
      );
      expect(ethPriceRecoveryDb.repair).toHaveBeenCalledTimes(2);
      await syncEthUsdPrice(false);
      expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('finds historical and trailing holes even behind live samples, allowing scheduling jitter', async () => {
    await putPrice(base, 100);
    await putPrice(base + 301_000, 110);
    await putPrice(base + 1200_000, 120);
    const gaps = await repo.findGaps(base + 1800_000);
    expect(gaps).toContainEqual({
      start: base + 1200_000,
      end: base + 1800_000
    });
    expect(gaps).toContainEqual({
      start: base + 301_000,
      end: base + 1200_000
    });
    expect(gaps).not.toContainEqual({ start: base, end: base + 301_000 });
  });
  it('pages older gaps using the prior page boundary', async () => {
    for (let i = 0; i < 11; i++) await putPrice(base - i * 900_000, 100);
    const firstPage = await repo.findGaps(base);
    expect(firstPage).toHaveLength(8);
    const secondPage = await repo.findGaps(base, [], firstPage[7].start);
    expect(secondPage).toHaveLength(3);
    expect(secondPage[0].end).toBe(firstPage[7].start);
    expect(secondPage[2].start).toBe(FIVE_MINUTE_HISTORY_START_MS - 1);
  });
  it('keeps the bootstrap prefix discoverable after recent prices are inserted', async () => {
    await putPrice(base, 100);
    expect(await repo.findGaps(base)).toEqual([
      { start: FIVE_MINUTE_HISTORY_START_MS - 1, end: base }
    ]);
  });

  it('skips more than eight unavailable ranges without hiding older recoverable history', async () => {
    const unavailable = [];
    for (let i = 0; i < 10; i++) {
      const start = base - i * 1800_000;
      await putPrice(start, 100);
      unavailable.push({
        first: start + 300_000,
        last: start + 1500_000,
        retryAt: base + 86400_000
      });
    }
    const now = base + 1800_000;
    const gaps = await repo.findGaps(now, unavailable);
    expect(gaps).toEqual([
      { start: FIVE_MINUTE_HISTORY_START_MS - 1, end: base - 9 * 1800_000 }
    ]);
    const retried = await repo.findGaps(
      now,
      unavailable.map((range) => ({ ...range, retryAt: now }))
    );
    expect(retried).toHaveLength(8);
  });
  it('continues the older side of a long gap when its recent day has no provider data', async () => {
    const now = base + 1800_000;
    const first = base - 86400_000;
    expect(
      await repo.findGaps(now, [
        { first, last: base + 1500_000, retryAt: now + 86400_000 }
      ])
    ).toEqual([{ start: FIVE_MINUTE_HISTORY_START_MS - 1, end: first - 1 }]);
  });
  it('recognizes any row in a pre-2026 UTC day as coverage and preserves dense days', async () => {
    const day = DAILY_PRICE_INTERVAL_MS;
    const boundary = FIVE_MINUTE_HISTORY_START_MS;
    // Suppress the already-covered historical prefix to isolate the last four days.
    const unavailable = [
      { first: HISTORY_START_MS, last: boundary - 5 * day, retryAt: base + day }
    ];
    await putPrice(boundary - 4 * day + 123_000, 100);
    await putPrice(boundary - 2 * day, 200);
    await putPrice(boundary - 2 * day + PRICE_INTERVAL_MS, 201);
    await putPrice(boundary - day + 12 * 3600_000, 300);
    expect(await repo.findDailyGaps(base, unavailable)).toEqual([
      { start: boundary - 4 * day, end: boundary - 2 * day }
    ]);
    const fiveMinuteGaps = await repo.findGaps(
      boundary + 3 * PRICE_INTERVAL_MS,
      [
        {
          first: HISTORY_START_MS + PRICE_INTERVAL_MS,
          last: boundary - day,
          retryAt: base + day
        }
      ]
    );
    expect(fiveMinuteGaps).toEqual([
      { start: boundary - 1, end: boundary + 3 * PRICE_INTERVAL_MS }
    ]);
  });

  it('does not lose the first five-minute close to the scheduling-jitter tolerance', async () => {
    const first = FIVE_MINUTE_HISTORY_START_MS;
    await putPrice(first + PRICE_INTERVAL_MS, 200);
    expect(await repo.findGaps(first + 2 * PRICE_INTERVAL_MS)).toEqual([
      { start: first - 1, end: first + PRICE_INTERVAL_MS }
    ]);
  });

  it('does not backfill the first historical day when it already has an off-grid sample', async () => {
    await putPrice(HISTORY_START_MS + 500, 100);
    await putPrice(HISTORY_START_MS + DAILY_PRICE_INTERVAL_MS + 500, 200);
    expect(
      await repo.findDailyGaps(
        base,
        [],
        HISTORY_START_MS + DAILY_PRICE_INTERVAL_MS
      )
    ).toEqual([]);
  });

  it('keeps the first historical day discoverable and respects daily retry boundaries', async () => {
    const day = DAILY_PRICE_INTERVAL_MS;
    await putPrice(HISTORY_START_MS + day + 500, 100);
    expect(await repo.findDailyGaps(base, [], HISTORY_START_MS + day)).toEqual([
      { start: HISTORY_START_MS - 1, end: HISTORY_START_MS + day }
    ]);
    const omitted = HISTORY_START_MS + 3 * day;
    expect(
      await repo.findDailyGaps(
        base,
        [{ first: omitted, last: omitted + day, retryAt: base + day }],
        omitted - 1
      )
    ).toContainEqual({ start: HISTORY_START_MS + day, end: omitted - 1 });
  });

  it('restores only an absent old day, fixes its transaction, and is idle on the next invocation', async () => {
    const day = DAILY_PRICE_INTERVAL_MS;
    const boundary = FIVE_MINUTE_HISTORY_START_MS;
    const missing = boundary - 2 * day;
    const now = boundary + 2 * PRICE_INTERVAL_MS;
    await putPrice(missing - day + 1000, 100);
    await putPrice(missing + day, 300);
    await putPrice(boundary, 400);
    await putPrice(boundary + PRICE_INTERVAL_MS, 410);
    await putTx(tx('daily-hole', missing + 3600_000));
    await putTx(tx('covered-old-day', missing + day + 3600_000));
    prepareCollector(now, boundary);
    jest
      .mocked(getUnavailablePrices)
      .mockImplementation(async (_now, interval) =>
        interval === day
          ? [
              {
                first: HISTORY_START_MS,
                last: missing - 2 * day,
                retryAt: now + day
              }
            ]
          : []
      );
    jest.mocked(fetchHistoricPrices).mockResolvedValue([sample(missing, 250)]);
    try {
      await syncEthUsdPrice(false);
      expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
      expect(fetchHistoricPrices).toHaveBeenCalledWith(
        missing,
        missing,
        now,
        day
      );
      expect(await readTx('daily-hole')).toMatchObject({
        eth_price_usd: 250,
        value_usd: 500,
        gas_usd: 25
      });
      expect(await readTx('covered-old-day')).toMatchObject({
        eth_price_usd: 100
      });
      const oldRows = await sqlExecutor.execute<{ timestamp_ms: number }>(
        `SELECT timestamp_ms FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms < :boundary ORDER BY timestamp_ms`,
        { boundary }
      );
      expect(oldRows.map((row) => Number(row.timestamp_ms))).toEqual([
        missing - day + 1000,
        missing,
        missing + day
      ]);
      await syncEthUsdPrice(false);
      expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('normalizes fractional write timestamps to the unchanged DATETIME precision', async () => {
    await putPrice(base, 100);
    await putPrice(base + 300_500, 200);
    const row = tx('fractional-input', base + 300_900);
    await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        await refreshTransactionUsdAtWrite(row, (sql, parameters) =>
          sqlExecutor.execute(
            sql.replace('?', ':time'),
            { time: parameters[0] },
            { wrappedConnection: connection }
          )
        );
        await putTx(row, { connection });
      },
      { isolationLevel: 'REPEATABLE READ' }
    );
    expect(row.transaction_date.getTime()).toBe(base + 300_000);
    expect(await readTx('fractional-input')).toMatchObject({
      eth_price_usd: 100
    });
    await repo.repair([sample(base, 100)], false, base + 600_000);
    expect(await readTx('fractional-input')).toMatchObject({
      eth_price_usd: 100
    });
  });
  it('preserves incoming USD values when no saved price is available', async () => {
    const row = tx('unpriced', base);
    await new TransactionsDiscoveryDb(
      () => sqlExecutor
    ).batchUpsertTransactions([row]);
    expect(await readTx('unpriced')).toMatchObject({
      eth_price_usd: 100,
      value_usd: 200,
      gas_usd: 10
    });
  });
  it('atomically corrects transaction USD and persisted mint totals through the next sample', async () => {
    await putPrice(base, 100);
    await putPrice(base + 900_000, 300);
    await putTx(tx('before', base + 299_000));
    await putTx(tx('inside', base + 300_000));
    await putTx(tx('tail', base + 899_000));
    await putTx(tx('boundary', base + 900_000));
    await putStats();
    await repo.repair([sample(base + 300_000, 200)], false, base + 1200_000);
    expect(await readTx('inside')).toMatchObject({
      eth_price_usd: 200,
      value_usd: 400,
      gas_usd: 20,
      value: 2,
      gas: 0.1
    });
    expect(await readTx('tail')).toMatchObject({ eth_price_usd: 200 });
    expect(await readTx('before')).toMatchObject({ eth_price_usd: 100 });
    expect(await readTx('boundary')).toMatchObject({ eth_price_usd: 100 });
    const stats = await sqlExecutor.oneOrNull(
      `SELECT * FROM ${MEMES_MINT_STATS_TABLE} WHERE id=1`
    );
    expect(stats).toMatchObject({
      proceeds_eth: 7,
      artist_split_eth: 3.5,
      proceeds_usd: Math.round(600 * MEMES_MINT_PRICE * 100) / 100
    });
    await repo.repair([sample(base + 300_000, 200)], false, base + 1200_000);
    expect(await readTx('inside')).toMatchObject({ value_usd: 400 });
  });
  it('repairs a transaction in the same second before the next millisecond sample', async () => {
    await putPrice(base, 100);
    await putPrice(base + 900_500, 300);
    await putTx(tx('fractional-boundary', base + 900_000));
    await repo.repair([sample(base + 300_000, 200)], false, base + 1200_000);
    expect(await readTx('fractional-boundary')).toMatchObject({
      eth_price_usd: 200
    });
  });
  it('corrects subscription redemption totals even when the transfer has no ETH value', async () => {
    await putPrice(base, 100);
    const row = { ...tx('redeem', base + 300_000), value: 0 };
    await putTx(row);
    await putStats();
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_REDEEMED_TABLE}
      (contract,token_id,address,transaction,consolidation_key,value,balance_after,count)
      VALUES (:contract,1,:address,:transaction,'test-redemption',0,0,2)`,
      {
        contract: MEMES_CONTRACT,
        address: row.to_address,
        transaction: row.transaction
      }
    );
    await repo.repair([sample(base + 300_000, 200)], false, base + 600_000);
    expect(
      await sqlExecutor.oneOrNull(
        `SELECT proceeds_usd, proceeds_eth FROM ${MEMES_MINT_STATS_TABLE} WHERE id=1`
      )
    ).toEqual({
      proceeds_usd: Math.round(2 * 200 * MEMES_MINT_PRICE * 100) / 100,
      proceeds_eth: 7
    });
  });
  it('does not recalculate mint totals for unrelated secondary transfers', async () => {
    await putPrice(base, 100);
    await putStats();
    await putTx({
      ...tx('secondary', base + 300_000),
      from_address: '0x2222222222222222222222222222222222222222'
    });
    await repo.repair([sample(base + 300_000, 200)], false, base + 600_000);
    expect(await readTx('secondary')).toMatchObject({ eth_price_usd: 200 });
    expect(
      await sqlExecutor.oneOrNull(
        `SELECT proceeds_usd FROM ${MEMES_MINT_STATS_TABLE} WHERE id=1`
      )
    ).toEqual({ proceeds_usd: 999 });
  });
  it('preserves exact existing samples normally and replaces them only for reset', async () => {
    await putPrice(base, 100);
    await putTx(tx('old', base));
    await repo.repair([sample(base, 200)], false, base + 300_000);
    expect(await readTx('old')).toMatchObject({ eth_price_usd: 100 });
    await repo.repair([sample(base, 200)], true, base + 300_000);
    expect(await readTx('old')).toMatchObject({ eth_price_usd: 200 });
  });
  it('rolls back price samples and transactions if derived-stat repair fails', async () => {
    await putPrice(base, 100);
    await putTx(tx('rollback', base + 300_000));
    await putStats();
    const original = sqlExecutor.execute.bind(sqlExecutor);
    const spy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation((sql, params, options) => {
        if (sql.includes(`UPDATE ${MEMES_MINT_STATS_TABLE}`))
          throw new Error('injected stat failure');
        return original(sql, params, options);
      });
    try {
      await expect(
        repo.repair([sample(base + 300_000, 200)], false, base + 900_000)
      ).rejects.toMatchObject({
        stage: 'update-mint-totals',
        cause: new Error('injected stat failure')
      });
    } finally {
      spy.mockRestore();
    }
    expect(await readTx('rollback')).toMatchObject({ eth_price_usd: 100 });
    expect(
      await sqlExecutor.execute(
        `SELECT * FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms=:ms`,
        { ms: base + 300_000 }
      )
    ).toEqual([]);
  });
  it('revalues late-arriving/replayed transactions at the write boundary', async () => {
    await putPrice(base, 100);
    const row = tx('late', base + 600_000);
    await repo.repair([sample(base + 300_000, 250)], false, base + 900_000);
    await new TransactionsDiscoveryDb(
      () => sqlExecutor
    ).batchUpsertTransactions([row]);
    expect(await readTx('late')).toMatchObject({
      eth_price_usd: 250,
      value_usd: 500,
      gas_usd: 25
    });
  });
  it('uses corrected prices even when the writer established an earlier snapshot', async () => {
    await putPrice(base, 100);
    const row = tx('old-snapshot', base + 600_000);
    await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        await sqlExecutor.execute(
          `SELECT * FROM ${ETH_PRICE_TABLE}`,
          undefined,
          { wrappedConnection: connection }
        );
        await repo.repair([sample(base + 300_000, 250)], false, base + 900_000);
        await refreshTransactionUsdAtWrite(row, (sql, parameters) =>
          sqlExecutor.execute(
            sql.replace('?', ':time'),
            { time: parameters[0] },
            { wrappedConnection: connection }
          )
        );
        await putTx(row, { connection });
      },
      { isolationLevel: 'REPEATABLE READ' }
    );
    expect(await readTx('old-snapshot')).toMatchObject({
      eth_price_usd: 250,
      value_usd: 500
    });
  });
  it('holds the price range until an in-flight writer commits, then corrects that row', async () => {
    await putPrice(base, 100);
    let release!: () => void;
    let read!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      read = resolve;
    });
    const row = tx('racing', base + 600_000);
    const writer = sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        await refreshTransactionUsdAtWrite(row, (sql, parameters) =>
          sqlExecutor.execute(
            sql.replace('?', ':time'),
            { time: parameters[0] },
            { wrappedConnection: connection }
          )
        );
        read();
        await hold;
        await putTx(row, { connection });
      },
      { isolationLevel: 'REPEATABLE READ' }
    );
    await Promise.race([ready, writer]);
    const repair = repo.repair(
      [sample(base + 300_000, 200)],
      false,
      base + 900_000
    );
    // Let the competing connection reach the locked price range.
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([writer, repair]);
    expect(await readTx('racing')).toMatchObject({
      eth_price_usd: 200,
      value_usd: 400
    });
  });
  it('uses every persisted interval including off-grid samples and fractional boundaries', async () => {
    await putPrice(base, 100);
    await putPrice(base + 450_500, 175);
    await putPrice(base + 900_000, 300);
    for (const offset of [
      299_000, 300_000, 450_000, 451_000, 599_000, 600_000, 899_000, 900_000
    ]) {
      await putTx(tx(`interval-${offset}`, base + offset));
    }
    await repo.repair(
      [sample(base + 300_000, 200), sample(base + 600_000, 250)],
      false,
      base + 1200_000
    );
    for (const [offset, price] of [
      [299_000, 100],
      [300_000, 200],
      [450_000, 200],
      [451_000, 175],
      [599_000, 175],
      [600_000, 250],
      [899_000, 250],
      [900_000, 100]
    ]) {
      expect(await readTx(`interval-${offset}`)).toMatchObject({
        eth_price_usd: price,
        value_usd: 2 * price,
        gas_usd: 0.1 * price
      });
    }
  });

  it('recalculates each affected token including its mints outside the repaired interval', async () => {
    await putPrice(base, 100);
    await putPrice(base + 900_000, 300);
    await putStats();
    await sqlExecutor.execute(`INSERT INTO ${MEMES_MINT_STATS_TABLE}
      (id,mint_date,mint_count,direct_mint_count,subscriptions_count,proceeds_eth,proceeds_usd,artist_split_eth,artist_split_usd,payment_details)
      SELECT 2,mint_date,mint_count,direct_mint_count,subscriptions_count,proceeds_eth,proceeds_usd,artist_split_eth,artist_split_usd,payment_details FROM ${MEMES_MINT_STATS_TABLE} WHERE id=1`);
    await putTx(tx('mint-one', base + 300_000));
    await putTx({ ...tx('mint-two', base + 600_000), token_id: 2 });
    await putTx({
      ...tx('mint-one-outside', base - 300_000),
      eth_price_usd: 400
    });
    await repo.repair(
      [sample(base + 300_000, 200), sample(base + 600_000, 250)],
      false,
      base + 1200_000
    );
    const totals = await sqlExecutor.execute<{
      id: number;
      proceeds_usd: number;
    }>(`SELECT id,proceeds_usd FROM ${MEMES_MINT_STATS_TABLE} ORDER BY id`);
    expect(totals).toEqual([
      { id: 1, proceeds_usd: Math.round(600 * MEMES_MINT_PRICE * 100) / 100 },
      { id: 2, proceeds_usd: Math.round(250 * MEMES_MINT_PRICE * 100) / 100 }
    ]);
  });

  it('keeps the separately committed live price when historical correction rolls back', async () => {
    await putPrice(base, 100);
    await putTx(tx('failed-history', base + 300_000));
    const livePrice = sample(base + 1800_000, 275);
    await repo.saveLive(livePrice);
    const execute = sqlExecutor.execute.bind(sqlExecutor);
    const spy = jest
      .spyOn(sqlExecutor, 'execute')
      .mockImplementation((sql, params, options) => {
        if (sql.includes(`UPDATE ${TRANSACTIONS_TABLE}`))
          throw new Error('injected update failure');
        return execute(sql, params, options);
      });
    try {
      await expect(
        repo.repair([sample(base + 300_000, 200)], false, base + 1800_000)
      ).rejects.toBeInstanceOf(EthPriceRepairError);
    } finally {
      spy.mockRestore();
    }
    expect(
      await sqlExecutor.execute(
        `SELECT timestamp_ms,usd_price FROM ${ETH_PRICE_TABLE} ORDER BY timestamp_ms`
      )
    ).toEqual([
      { timestamp_ms: base, usd_price: 100 },
      { timestamp_ms: livePrice.timestamp_ms, usd_price: 275 }
    ]);
    expect(await readTx('failed-history')).toMatchObject({
      eth_price_usd: 100
    });
  });
  it('does not wait on an unrelated locked mint-stat row', async () => {
    await putPrice(base, 100);
    await putPrice(base + 900_000, 300);
    await putTx(tx('affected-mint', base + 300_000));
    await putStats();
    await sqlExecutor.execute(`INSERT INTO ${MEMES_MINT_STATS_TABLE}
      (id,mint_date,mint_count,direct_mint_count,subscriptions_count,proceeds_eth,proceeds_usd,artist_split_eth,artist_split_usd,payment_details)
      SELECT 2,mint_date,mint_count,direct_mint_count,subscriptions_count,proceeds_eth,proceeds_usd,artist_split_eth,artist_split_usd,payment_details FROM ${MEMES_MINT_STATS_TABLE} WHERE id=1`);
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await sqlExecutor.execute(
        `SELECT id FROM ${MEMES_MINT_STATS_TABLE} WHERE id=2 FOR UPDATE`,
        undefined,
        { wrappedConnection: connection }
      );
      // The repair runs on a separate connection while id=2 remains locked.
      await repo.repair([sample(base + 300_000, 200)], false, base + 1200_000);
    });
    expect(await readTx('affected-mint')).toMatchObject({ eth_price_usd: 200 });
    expect(
      await sqlExecutor.oneOrNull(
        `SELECT proceeds_usd FROM ${MEMES_MINT_STATS_TABLE} WHERE id=2`
      )
    ).toEqual({ proceeds_usd: 999 });
  });
  it.each([false, true])(
    'values a freshly saved off-grid quote by timestamp during repair (reset=%s)',
    async (overwrite) => {
      const started = base + 720_000;
      const freshLive = sample(base + 480_500, 900);
      await putPrice(base, 50);
      await putStats();
      const expected = [
        [300_000, 100],
        [480_000, 100], // DATETIME second precedes the millisecond live tick.
        [481_000, 900], // Latest saved sample is the newly committed live tick.
        [599_000, 900],
        [600_000, 200], // A later historical close supersedes the earlier tick.
        [719_000, 200]
      ];
      for (const [offset] of expected) {
        await putTx(tx(`fresh-live-${offset}`, base + offset));
      }
      // Same ordering as the collector: the quote is under five minutes old,
      // commits first, and falls strictly inside the following repair range.
      await repo.saveLive(freshLive);
      await repo.repair(
        [sample(base + 300_000, 100), sample(base + 600_000, 200)],
        overwrite,
        started
      );
      for (const [offset, price] of expected) {
        const row = await readTx(`fresh-live-${offset}`);
        expect(row).toMatchObject({
          eth_price_usd: price,
          value_usd: 2 * price,
          gas_usd: 0.1 * price
        });
        // The normal transaction writer must agree with recovery for the same row.
        const writerRow = tx(`fresh-live-${offset}`, base + offset);
        await new TransactionsDiscoveryDb(
          () => sqlExecutor
        ).batchUpsertTransactions([writerRow]);
        expect(await readTx(`fresh-live-${offset}`)).toMatchObject({
          eth_price_usd: price,
          value_usd: 2 * price,
          gas_usd: 0.1 * price
        });
      }
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT usd_price FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms=:timestamp`,
          { timestamp: freshLive.timestamp_ms }
        )
      ).toEqual({ usd_price: 900 });
      // The aggregate was repaired atomically and remains unchanged by the writer replays.
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT proceeds_usd FROM ${MEMES_MINT_STATS_TABLE} WHERE id=1`
        )
      ).toEqual({
        proceeds_usd: Math.round(2400 * MEMES_MINT_PRICE * 100) / 100
      });
    }
  );
});
