import { performance } from 'node:perf_hooks';
import { EthPriceRepairError, RepairStage } from './eth-price-failure';
import { UnavailablePrices } from './eth-price-unavailable';
import {
  ETH_PRICE_TABLE,
  TRANSACTIONS_TABLE,
  MEMES_CONTRACT,
  MANIFOLD,
  NULL_ADDRESS,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  MEMES_MINT_STATS_TABLE
} from '@/constants';
import { EthPrice } from '@/entities/IEthPrice';
import { calculateMemesMintStats } from '@/memes-mint-stats/memes-mint-stats';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import {
  HISTORY_START_MS,
  PRICE_INTERVAL_MS,
  PRICE_TOLERANCE_MS
} from './coinbase';

export type PriceGap = { start: number; end: number };

export class EthPriceRecoveryDb extends LazyDbAccessCompatibleService {
  async findGaps(
    now: number,
    unavailable: UnavailablePrices[] = [],
    ctx: RequestContext = {}
  ): Promise<PriceGap[]> {
    const timer = 'EthPriceRecoveryDb.findGaps';
    ctx.timer?.start(timer);
    try {
      // Price rows are the durable checkpoint: newer live prices cannot hide holes.
      const rows = await this.db.execute<{ start_ms: number; end_ms: number }>(
        `WITH unavailable AS (
           SELECT first_close, last_close FROM JSON_TABLE(:unavailable, '$[*]' COLUMNS (
             first_close BIGINT PATH '$.first', last_close BIGINT PATH '$.last'
           )) AS ranges_to_retry
         ), points AS (
           SELECT timestamp_ms FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms >= :historyStart AND timestamp_ms <= :now
           UNION SELECT :now
           UNION SELECT :historyStart
           UNION SELECT first_close - :intervalMs FROM unavailable
           UNION SELECT last_close FROM unavailable
         ), intervals AS (
           SELECT timestamp_ms AS start_ms, LEAD(timestamp_ms) OVER (ORDER BY timestamp_ms) AS end_ms FROM points
         ) SELECT start_ms, end_ms FROM intervals
         WHERE end_ms - start_ms > :threshold
           AND NOT EXISTS (SELECT 1 FROM unavailable u
             WHERE start_ms >= u.first_close - :intervalMs AND end_ms <= u.last_close)
         ORDER BY end_ms DESC LIMIT 8`,
        {
          now,
          unavailable: JSON.stringify(
            unavailable.filter(
              (range) => range.retryAt > now && range.last <= now
            )
          ),
          intervalMs: PRICE_INTERVAL_MS,
          historyStart: HISTORY_START_MS,
          threshold: PRICE_INTERVAL_MS + PRICE_TOLERANCE_MS
        },
        { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
      );
      return rows.map((row) => ({
        start: Number(row.start_ms),
        end: Number(row.end_ms)
      }));
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  async saveLive(price: EthPrice): Promise<void> {
    await this.db.execute(
      `INSERT IGNORE INTO ${ETH_PRICE_TABLE} (timestamp_ms, date, usd_price) VALUES (:timestamp_ms, :date, :usd_price)`,
      {
        ...price,
        date: price.date.toISOString().slice(0, 19).replace('T', ' ')
      }
    );
  }

  async repair(
    prices: EthPrice[],
    overwrite: boolean,
    until: number
  ): Promise<void> {
    if (!prices.length) return;
    let stage: RepairStage = 'insert-prices';
    try {
      await this.db.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx: RequestContext = { connection };
          await this.insertPrices(prices, overwrite, ctx);
          const first = prices[0].timestamp_ms;
          const last = prices[prices.length - 1].timestamp_ms;
          stage = 'read-price-intervals';
          const next = await this.db.oneOrNull<{ timestamp_ms: number }>(
            `SELECT timestamp_ms FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms > :last ORDER BY timestamp_ms LIMIT 1 FOR SHARE`,
            { last },
            { wrappedConnection: connection }
          );
          const end = Math.min(Number(next?.timestamp_ms ?? until), until);
          // Read persisted values: IGNORE preserves existing exact/off-grid samples.
          // Locking reads avoid an older repeatable-read snapshot and keep these
          // interval boundaries stable until all dependent values commit.
          const samples = await this.db.execute<{
            timestamp_ms: number;
            usd_price: number;
          }>(
            `SELECT timestamp_ms, usd_price FROM ${ETH_PRICE_TABLE}
             WHERE timestamp_ms >= :first AND timestamp_ms < :end
             ORDER BY timestamp_ms FOR SHARE`,
            { first, end },
            { wrappedConnection: connection }
          );
          stage = 'update-transactions';
          for (let i = 0; i < samples.length; i++) {
            const sample = samples[i];
            await this.db.execute(
              `UPDATE ${TRANSACTIONS_TABLE} SET
                 eth_price_usd = :price, value_usd = value * :price, gas_usd = gas * :price
               WHERE transaction_date >= :start AND transaction_date < :end`,
              {
                price: Number(sample.usd_price),
                ...this.dateRange(
                  Number(sample.timestamp_ms),
                  Number(samples[i + 1]?.timestamp_ms ?? end)
                )
              },
              { wrappedConnection: connection }
            );
          }
          stage = 'find-mint-tokens';
          const tokens = await this.findMintTokens(first, end, ctx);
          stage = 'update-mint-totals';
          for (const token of tokens) {
            const stats = await calculateMemesMintStats(
              token.id,
              token.mint_date ?? new Date(0),
              ctx,
              false
            );
            await this.db.execute(
              `UPDATE ${MEMES_MINT_STATS_TABLE} SET proceeds_usd = :proceeds, artist_split_usd = :artist WHERE id = :id`,
              {
                id: token.id,
                proceeds: stats.proceeds_usd,
                artist: stats.artist_split_usd
              },
              { wrappedConnection: connection }
            );
          }
        },
        {
          executionBudget: {
            deadlineMonotonicMillis: performance.now() + 90_000,
            maxStatementMillis: 30_000,
            finalizationReserveMillis: 5_000,
            lockWaitSeconds: 5
          }
        }
      );
    } catch (error) {
      throw new EthPriceRepairError(stage, error);
    }
  }

  private dateRange(first: number, end: number) {
    return {
      start: new Date(first).toISOString().slice(0, 23).replace('T', ' '),
      end: new Date(end).toISOString().slice(0, 23).replace('T', ' ')
    };
  }

  private async insertPrices(
    prices: EthPrice[],
    overwrite: boolean,
    ctx: RequestContext
  ) {
    const timer = 'EthPriceRecoveryDb.insertPrices';
    ctx.timer?.start(timer);
    try {
      for (const price of prices) {
        await this.db.execute(
          `INSERT ${overwrite ? '' : 'IGNORE'} INTO ${ETH_PRICE_TABLE} (timestamp_ms, date, usd_price)
         VALUES (:timestamp_ms, :date, :usd_price)
         ${overwrite ? 'ON DUPLICATE KEY UPDATE usd_price = VALUES(usd_price), date = VALUES(date)' : ''}`,
          {
            ...price,
            date: price.date.toISOString().slice(0, 19).replace('T', ' ')
          },
          { wrappedConnection: ctx.connection }
        );
      }
    } finally {
      ctx.timer?.stop(timer);
    }
  }

  private async findMintTokens(
    first: number,
    end: number,
    ctx: RequestContext
  ) {
    const timer = 'EthPriceRecoveryDb.findMintTokens';
    ctx.timer?.start(timer);
    try {
      // Start from the repaired date range, not a correlated scan of every mint.
      const affected = await this.db.execute<{ id: number }>(
        `SELECT DISTINCT t.token_id AS id FROM ${TRANSACTIONS_TABLE} t
       WHERE t.transaction_date >= :start AND t.transaction_date < :end
         AND t.contract = :contract
         AND ((t.from_address IN (:nullAddress, :manifold)
           AND t.to_address NOT IN (:nullAddress, :manifold) AND t.value > 0)
           OR EXISTS (SELECT 1 FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} rs
             WHERE rs.transaction = t.transaction AND rs.contract = t.contract
               AND rs.token_id = t.token_id AND LOWER(rs.address) = LOWER(t.to_address)))`,
        {
          ...this.dateRange(first, end),
          contract: MEMES_CONTRACT,
          nullAddress: NULL_ADDRESS,
          manifold: MANIFOLD
        },
        { wrappedConnection: ctx.connection }
      );
      if (!affected.length) return [];
      return await this.db.execute<{ id: number; mint_date: Date | null }>(
        `SELECT id, mint_date FROM ${MEMES_MINT_STATS_TABLE}
       WHERE id IN (:ids) ORDER BY id FOR UPDATE`,
        { ids: affected.map((token) => token.id) },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timer);
    }
  }
}
export const ethPriceRecoveryDb = new EthPriceRecoveryDb(dbSupplier);
