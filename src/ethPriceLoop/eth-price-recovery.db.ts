import {
  ETH_PRICE_TABLE,
  TRANSACTIONS_TABLE,
  MEMES_CONTRACT,
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
  async findGaps(now: number, ctx: RequestContext = {}): Promise<PriceGap[]> {
    const timer = 'EthPriceRecoveryDb.findGaps';
    ctx.timer?.start(timer);
    try {
      // Price rows are the durable checkpoint: newer live prices cannot hide holes.
      const rows = await this.db.execute<{ start_ms: number; end_ms: number }>(
        `WITH points AS (
           SELECT timestamp_ms FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms >= :historyStart AND timestamp_ms <= :now
           UNION SELECT :now
           UNION SELECT :historyStart
         ), intervals AS (
           SELECT timestamp_ms AS start_ms, LEAD(timestamp_ms) OVER (ORDER BY timestamp_ms) AS end_ms FROM points
         ) SELECT start_ms, end_ms FROM intervals
         WHERE end_ms - start_ms > :threshold ORDER BY end_ms DESC LIMIT 8`,
        {
          now,
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
    await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const ctx: RequestContext = { connection };
        for (const price of prices) {
          await this.db.execute(
            `INSERT ${overwrite ? '' : 'IGNORE'} INTO ${ETH_PRICE_TABLE} (timestamp_ms, date, usd_price)
           VALUES (:timestamp_ms, :date, :usd_price)
           ${overwrite ? 'ON DUPLICATE KEY UPDATE usd_price = VALUES(usd_price), date = VALUES(date)' : ''}`,
            {
              ...price,
              date: price.date.toISOString().slice(0, 19).replace('T', ' ')
            },
            { wrappedConnection: connection }
          );
        }
        const first = prices[0].timestamp_ms;
        const last = prices[prices.length - 1].timestamp_ms;
        const next = await this.db.oneOrNull<{ timestamp_ms: number }>(
          `SELECT timestamp_ms FROM ${ETH_PRICE_TABLE} WHERE timestamp_ms > :last ORDER BY timestamp_ms LIMIT 1 FOR SHARE`,
          { last },
          { wrappedConnection: connection }
        );
        const end = Math.min(Number(next?.timestamp_ms ?? until), until);
        // Match persisted DATETIME precision independently of the session timezone.
        const priceAtTransaction = `(SELECT p.usd_price FROM ${ETH_PRICE_TABLE} p
        WHERE p.timestamp_ms <= TIMESTAMPDIFF(MICROSECOND, '1970-01-01', t.transaction_date) / 1000
        ORDER BY p.timestamp_ms DESC LIMIT 1)`;
        const range = {
          start: new Date(first).toISOString().slice(0, 23).replace('T', ' '),
          end: new Date(end).toISOString().slice(0, 23).replace('T', ' ')
        };
        await this.db.execute(
          `UPDATE ${TRANSACTIONS_TABLE} t SET
           eth_price_usd = ${priceAtTransaction},
           value_usd = t.value * ${priceAtTransaction},
           gas_usd = t.gas * ${priceAtTransaction}
         WHERE t.transaction_date >= :start AND t.transaction_date < :end`,
          range,
          { wrappedConnection: connection }
        );
        const tokens = await this.db.execute<{
          id: number;
          mint_date: Date | null;
        }>(
          `SELECT m.id, m.mint_date FROM ${MEMES_MINT_STATS_TABLE} m
         WHERE EXISTS (SELECT 1 FROM ${TRANSACTIONS_TABLE} t WHERE t.contract = :contract AND t.token_id = m.id
           AND t.transaction_date >= :start AND t.transaction_date < :end) FOR UPDATE`,
          { ...range, contract: MEMES_CONTRACT },
          { wrappedConnection: connection }
        );
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
      { isolationLevel: 'REPEATABLE READ' }
    );
  }
}
export const ethPriceRecoveryDb = new EthPriceRecoveryDb(dbSupplier);
