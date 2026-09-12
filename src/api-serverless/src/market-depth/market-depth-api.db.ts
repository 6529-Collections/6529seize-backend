import {
  GRADIENT_CONTRACT,
  MARKET_DEPTH_COLLECTION_STATE_TABLE,
  MARKET_DEPTH_EVENTS_TABLE,
  MARKET_DEPTH_SNAPSHOTS_TABLE,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFTS_MEME_LAB_TABLE,
  NFTS_TABLE
} from '@/constants';
import { NEXTGEN_CORE } from '@/api/nextgen/abis';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { NEXTGEN_TOKENS_TABLE } from '@/nextgen/nextgen_constants';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';
import { marketDepthDb } from '@/market-depth/market-depth.db';
import {
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot,
  MAX_MARKET_DEPTH_COLLECTION_ASKS,
  MAX_MARKET_DEPTH_COLLECTION_PARTITIONS,
  MarketDepthOrderStatus
} from '@/market-depth/market-depth.types';
import { DbPoolName } from '@/db-query.options';

export const MARKET_CONTRACTS = [
  MEMES_CONTRACT,
  MEMELAB_CONTRACT,
  GRADIENT_CONTRACT,
  NEXTGEN_CORE[1]
].map((contract) => contract.toLowerCase());

export interface MarketTokenContext {
  contract: string;
  token_id: string;
  collection_id: number | null;
}

export interface OrderStatusObservation {
  order_id: string;
  kind: string;
  occurred_at: Date;
}

const ORDER_STATUSES: Record<string, MarketDepthOrderStatus> = {
  cancel: 'CANCELLED',
  cancellation: 'CANCELLED',
  cancelled: 'CANCELLED',
  item_cancelled: 'CANCELLED',
  listing_cancelled: 'CANCELLED',
  offer_cancelled: 'CANCELLED',
  expire: 'EXPIRED',
  expiration: 'EXPIRED',
  expired: 'EXPIRED',
  invalidate: 'INACTIVE',
  invalidation: 'INACTIVE',
  inactive: 'INACTIVE',
  order_invalidate: 'INACTIVE',
  sale: 'INACTIVE',
  sold: 'INACTIVE',
  item_sold: 'INACTIVE',
  fulfilled: 'FULFILLED'
};
const TERMINAL_STATUSES = new Set<MarketDepthOrderStatus>([
  'CANCELLED',
  'FULFILLED',
  'EXPIRED'
]);
const TERMINAL_KINDS = Object.entries(ORDER_STATUSES)
  .filter(([, status]) => TERMINAL_STATUSES.has(status))
  .map(([kind]) => kind);
const OBSERVATION_KINDS = [
  ...Object.keys(ORDER_STATUSES),
  'revalidate',
  'revalidation',
  'order_revalidate'
];

export function applyOrderStatusObservation(
  order: CurrentMarketDepthOrder,
  observation: OrderStatusObservation | undefined,
  refreshStartedAt: Date = order.observed_at
): CurrentMarketDepthOrder {
  if (!observation) return order;
  const status = ORDER_STATUSES[observation.kind.toLowerCase()];
  if (!status) return order;
  const occurredAt = new Date(observation.occurred_at);
  const terminal = TERMINAL_STATUSES.has(status);
  // Pages are fetched over time: an order from an early page can be invalidated
  // before the snapshot finishes. Its common observed_at is not a safe cutoff.
  // Terminal states cannot be reversed by a later ACTIVE snapshot of this hash.
  if (!terminal && occurredAt.getTime() <= refreshStartedAt.getTime())
    return order;
  return {
    ...order,
    status,
    observed_at: new Date(
      Math.max(order.observed_at.getTime(), occurredAt.getTime())
    )
  };
}

export class MarketDepthApiDb extends LazyDbAccessCompatibleService {
  private async readBook(
    token: MarketTokenContext,
    partition: { source: string; collection_slug: string },
    scope: boolean | 'all',
    limit: number
  ): Promise<CurrentMarketDepthSnapshot | null> {
    if (scope !== 'all')
      return marketDepthDb.getLatestCompletedSnapshot(
        partition.source,
        token.contract,
        partition.collection_slug,
        scope
          ? { side: 'ask', limit }
          : { token_id: token.token_id, include_payloads: false }
      );
    // Reserve half of the existing collection bound for each side. An ask-heavy
    // collection must not consume the bid quota through SQL's side ordering.
    const [asks, bids] = await Promise.all(
      (['ask', 'bid'] as const).map((side) =>
        marketDepthDb.getLatestCompletedSnapshot(
          partition.source,
          token.contract,
          partition.collection_slug,
          { side, limit: Math.floor(limit / 2) }
        )
      )
    );
    if (!asks || !bids) return null;
    if (asks.snapshot.id !== bids.snapshot.id)
      throw new CustomApiCompliantException(
        503,
        'The indexed collection is updating. Refresh before trying again.'
      );
    return {
      snapshot: asks.snapshot,
      orders: [...asks.orders, ...bids.orders]
    };
  }

  async getToken(
    contract: string,
    tokenId: string
  ): Promise<MarketTokenContext> {
    if (!MARKET_CONTRACTS.includes(contract))
      throw new NotFoundException(
        'Market depth is unavailable for this collection'
      );
    const nextgen = contract === NEXTGEN_CORE[1].toLowerCase();
    let table = NFTS_TABLE;
    if (nextgen) table = NEXTGEN_TOKENS_TABLE;
    else if (contract === MEMELAB_CONTRACT.toLowerCase())
      table = NFTS_MEME_LAB_TABLE;
    const row = await this.db.oneOrNull<{ collection_id: number | null }>(
      `SELECT ${nextgen ? 'collection_id' : 'NULL AS collection_id'} FROM ${table}
       WHERE id=:tokenId ${nextgen ? '' : 'AND contract=:contract'} LIMIT 1`,
      { tokenId, contract }
    );
    if (!row) throw new NotFoundException('Token not found');
    return { contract, token_id: tokenId, collection_id: row.collection_id };
  }

  async getPartitions(
    token: MarketTokenContext
  ): Promise<{ source: string; collection_slug: string }[]> {
    return this.db.execute<{ source: string; collection_slug: string }>(
      `SELECT state.source, state.collection_slug FROM ${MARKET_DEPTH_COLLECTION_STATE_TABLE} state
       INNER JOIN ${MARKET_DEPTH_SNAPSHOTS_TABLE} s ON s.id=state.latest_snapshot_id
       WHERE state.contract=:contract AND state.chain_id='1'
         AND ${token.collection_id === null ? 's.collection_id IS NULL' : 's.collection_id=:collectionId'}
       ORDER BY state.source, state.collection_slug`,
      { contract: token.contract, collectionId: token.collection_id },
      { forcePool: DbPoolName.WRITE }
    );
  }

  async getBooks(
    token: MarketTokenContext,
    collectionListings: boolean | 'all' = false
  ): Promise<CurrentMarketDepthSnapshot[]> {
    const partitions = await this.getPartitions(token);
    if (
      collectionListings &&
      partitions.length > MAX_MARKET_DEPTH_COLLECTION_PARTITIONS
    )
      throw new CustomApiCompliantException(
        503,
        'The indexed collection is temporarily unavailable.'
      );
    const collectionLimit = Math.floor(
      MAX_MARKET_DEPTH_COLLECTION_ASKS / Math.max(1, partitions.length)
    );
    const books = await Promise.all(
      partitions.map((partition) =>
        this.readBook(token, partition, collectionListings, collectionLimit)
      )
    );
    const completed = books.filter(
      (book): book is CurrentMarketDepthSnapshot => book !== null
    );
    // A collection-wide read must account for every known partition. Token
    // depth can still display the partitions available during a refresh.
    if (collectionListings && completed.length !== partitions.length)
      throw new CustomApiCompliantException(
        503,
        'The indexed collection is temporarily unavailable.'
      );
    const orderIds = Array.from(
      new Set(
        completed.flatMap((book) => book.orders.map((order) => order.order_id))
      )
    );
    if (!orderIds.length) return completed;
    const observations = await this.db.execute<OrderStatusObservation>(
      `SELECT order_id, kind, occurred_at FROM (
         SELECT order_id, kind, occurred_at,
           ROW_NUMBER() OVER (PARTITION BY order_id ORDER BY
             CASE WHEN kind IN (:terminalKinds) THEN 1 ELSE 0 END DESC,
             occurred_at DESC, event_id DESC) AS position
         FROM ${MARKET_DEPTH_EVENTS_TABLE}
         WHERE source IN ('opensea','opensea_stream') AND chain_id='1'
           AND contract=:contract AND order_id IN (:orderIds)
           AND kind IN (:observationKinds)
       ) status_events WHERE position=1`,
      {
        contract: token.contract,
        orderIds,
        terminalKinds: TERMINAL_KINDS,
        observationKinds: OBSERVATION_KINDS
      },
      { forcePool: DbPoolName.WRITE }
    );
    const byOrder = new Map(
      observations.map((event) => [event.order_id, event])
    );
    return completed.map((book) => ({
      ...book,
      orders: book.orders.map((order) =>
        applyOrderStatusObservation(
          order,
          byOrder.get(order.order_id),
          book.snapshot.started_at
        )
      )
    }));
  }
}

export const marketDepthApiDb = new MarketDepthApiDb(dbSupplier);
