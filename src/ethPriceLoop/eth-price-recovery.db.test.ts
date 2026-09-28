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
import { EthPriceRecoveryDb } from './eth-price-recovery.db';
import { TransactionsDiscoveryDb } from '@/transactions/transactions.discovery.db';
import { refreshTransactionUsdAtWrite } from '@/eth-prices/transaction-usd';
import { HISTORY_START_MS } from './coinbase';
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
  it('keeps the bootstrap prefix discoverable after recent prices are inserted', async () => {
    await putPrice(base, 100);
    expect(await repo.findGaps(base)).toEqual([
      { start: HISTORY_START_MS, end: base }
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
      { start: HISTORY_START_MS, end: base - 9 * 1800_000 }
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
    ).toEqual([{ start: HISTORY_START_MS, end: first - 300_000 }]);
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
      ).rejects.toThrow('injected');
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
});
