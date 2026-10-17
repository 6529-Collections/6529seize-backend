import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DbPoolName } from '@/db-query.options';
import { Logger } from '@/logging';
import {
  MARKET_DEPTH_COLLECTION_STATE_TABLE,
  MARKET_DEPTH_PUBLICATION_LOCKS_TABLE,
  MARKET_DEPTH_CURRENT_ORDERS_TABLE,
  MARKET_DEPTH_CURSORS_TABLE,
  MARKET_DEPTH_EVENTS_TABLE,
  MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE,
  MARKET_DEPTH_SNAPSHOTS_TABLE
} from '@/constants/db-tables';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService,
  type SqlExecutionBudget
} from '@/sql-executor';
import {
  AppendMarketDepthEventsInput,
  CurrentMarketDepthOrder,
  CurrentMarketDepthSnapshot,
  MARKET_DEPTH_CHAIN,
  MARKET_DEPTH_CHAIN_ID,
  MARKET_DEPTH_SNAPSHOT_SCHEMA_VERSION,
  MAX_MARKET_DEPTH_ARCHIVE_BYTES,
  MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES,
  MAX_MARKET_DEPTH_COLLECTION_ASKS,
  MarketDepthCursor,
  MarketDepthJsonValue,
  MarketDepthReconciliation,
  MarketDepthReconciliationInput,
  MarketDepthReconciliationResolveInput,
  MarketDepthReconciliationRetryInput,
  MarketDepthReconciliationStatus,
  MarketDepthSnapshotArchive,
  MarketDepthSnapshotMetadata,
  MarketDepthSnapshotReadOptions,
  NormalizedMarketDepthOrder,
  PublishMarketDepthSnapshotInput
} from './market-depth.types';
import {
  MarketDepthEventPurgeBatch,
  MarketDepthEventPurgeKey
} from './market-depth-retention';

type DbConnection = ConnectionWrapper<unknown>;
const logger = Logger.get('MARKET_DEPTH_DB');
// Deliberately global: different collections can contend on shared PRIMARY pages.
const PUBLICATION_LOCK_ID = 'b78ed622-53d7-4d24-bcb8-4ff57edac806';

const RECONCILIATION_STATUSES: readonly MarketDepthReconciliationStatus[] = [
  'RESOLVED',
  'PENDING'
];

interface PurgePartition {
  source: string;
  collection_slug: string;
  latest_snapshot_id: string | null;
}

type SnapshotRow = Omit<MarketDepthSnapshotMetadata, 'chain' | 'chain_id'> & {
  chain: string;
  chain_id: string;
  source: string;
};

type ReconciliationRow = Omit<
  MarketDepthReconciliation,
  'chain' | 'chain_id' | 'prior_order'
> & {
  chain: string;
  chain_id: string;
  prior_order: unknown;
};

export class StaleMarketDepthSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'StaleMarketDepthSnapshotError';
  }
}

export class MarketDepthCursorConflictError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'MarketDepthCursorConflictError';
  }
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function bufferFromDb(value: unknown, field: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (
    value &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data);
  }
  throw new Error(`${field} is not a database buffer`);
}

function normalizeContract(contract: string): string {
  return contract.trim().toLowerCase();
}

function normalizePartition(value: string): string {
  return value.trim().toLowerCase();
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function assertPurgeLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error('Purge limit must be between 1 and 5000');
  }
}

function assertGzipArchive(archive: Buffer, field: string): void {
  if (archive.length > MAX_MARKET_DEPTH_ARCHIVE_BYTES) {
    throw new Error(
      `${field} exceeds the ${MAX_MARKET_DEPTH_ARCHIVE_BYTES} byte compressed archive limit`
    );
  }
  if (archive.length < 2 || archive[0] !== 0x1f || archive[1] !== 0x8b) {
    throw new Error(`${field} must contain gzip data`);
  }
}

function validateSnapshot(input: PublishMarketDepthSnapshotInput): void {
  if (input.completed_at.getTime() < input.started_at.getTime()) {
    throw new Error('completed_at must not precede started_at');
  }
  assertNonNegativeInteger(input.raw_order_count, 'raw_order_count');
  assertNonNegativeInteger(input.unsupported_count, 'unsupported_count');
  assertNonNegativeInteger(input.skipped_count, 'skipped_count');
  assertNonNegativeInteger(input.event_count, 'event_count');
  if (input.collection_id !== undefined && input.collection_id !== null) {
    assertNonNegativeInteger(input.collection_id, 'collection_id');
  }
  assertGzipArchive(input.raw_archive_gzip, 'raw_archive_gzip');
  assertGzipArchive(input.normalized_archive_gzip, 'normalized_archive_gzip');
  if (
    input.raw_archive_gzip.length + input.normalized_archive_gzip.length >
    MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES
  ) {
    throw new Error(
      `Snapshot archives exceed the ${MAX_MARKET_DEPTH_ARCHIVES_TOTAL_BYTES} byte combined compressed archive limit`
    );
  }

  const keys = new Set<string>();
  for (const order of input.orders) {
    if (keys.has(order.order_key)) {
      throw new Error(`Duplicate market-depth order key: ${order.order_key}`);
    }
    keys.add(order.order_key);
  }
}

function mapSnapshotRow(row: SnapshotRow): MarketDepthSnapshotMetadata {
  return {
    ...row,
    chain: MARKET_DEPTH_CHAIN,
    chain_id: MARKET_DEPTH_CHAIN_ID,
    started_at: new Date(row.started_at),
    completed_at: new Date(row.completed_at)
  };
}

function jsonForDb(value: MarketDepthJsonValue | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

function normalizedOrderFromJson(value: unknown): NormalizedMarketDepthOrder {
  const order = parseJson<NormalizedMarketDepthOrder>(value);
  return {
    ...order,
    start_at: order.start_at ? new Date(order.start_at) : null,
    end_at: order.end_at ? new Date(order.end_at) : null,
    observed_at: new Date(order.observed_at)
  };
}

function reconciliationId(input: MarketDepthReconciliationInput): string {
  return createHash('sha256')
    .update(
      [
        normalizePartition(input.source),
        MARKET_DEPTH_CHAIN_ID,
        normalizeContract(input.contract),
        normalizePartition(input.collection_slug),
        normalizePartition(input.order.protocol),
        input.order.order_id,
        input.prior_snapshot_id
      ].join('\0')
    )
    .digest('hex');
}

function orderForDb(
  snapshotId: string,
  source: string,
  contract: string,
  collectionSlug: string,
  order: NormalizedMarketDepthOrder
) {
  return {
    ...order,
    snapshot_id: snapshotId,
    chain: MARKET_DEPTH_CHAIN,
    chain_id: MARKET_DEPTH_CHAIN_ID,
    source,
    contract,
    collection_slug: collectionSlug,
    criteria: jsonForDb(order.criteria),
    protocol_data: jsonForDb(order.protocol_data),
    source_data: jsonForDb(order.source_data),
    executable_caveats: jsonForDb(order.executable_caveats)
  };
}

const ORDER_COLUMNS = [
  'order_key',
  'snapshot_id',
  'chain',
  'chain_id',
  'order_id',
  'source',
  'protocol',
  'contract',
  'collection_slug',
  'token_id',
  'side',
  'status',
  'is_private',
  'scope',
  'maker',
  'original_quantity',
  'remaining_quantity',
  'currency_contract',
  'currency_symbol',
  'currency_decimals',
  'current_price_raw',
  'current_price_decimal',
  'unit_price_decimal',
  'start_at',
  'end_at',
  'observed_at',
  'source_url',
  'criteria',
  'protocol_data',
  'source_data',
  'is_executable',
  'executable_caveats'
];

const EVENT_COLUMNS = [
  'event_id',
  'kind',
  'source',
  'source_evidence',
  'chain',
  'chain_id',
  'provider_at',
  'observed_at',
  'order_id',
  'contract',
  'collection_slug',
  'token_id',
  'maker',
  'taker',
  'quantity',
  'currency_contract',
  'currency_symbol',
  'currency_decimals',
  'price_raw',
  'price_decimal',
  'transaction_hash',
  'raw'
];

const RECONCILIATION_COLUMNS = [
  'id',
  'prior_snapshot_id',
  'source',
  'chain',
  'chain_id',
  'contract',
  'collection_slug',
  'protocol',
  'order_id',
  'order_key',
  'token_id',
  'side',
  'prior_order',
  'status',
  'first_missing_at',
  'next_attempt_at',
  'last_attempt_at',
  'attempt_count',
  'resolved_at',
  'last_error'
];

export class MarketDepthDb extends LazyDbAccessCompatibleService {
  private query<T>(
    sql: string,
    params: Record<string, unknown>,
    connection?: DbConnection
  ): Promise<T[]> {
    return this.db.execute<T>(sql, params, {
      wrappedConnection: connection,
      forcePool: DbPoolName.WRITE
    });
  }

  async publishCompletedSnapshot(
    input: PublishMarketDepthSnapshotInput
  ): Promise<MarketDepthSnapshotMetadata> {
    validateSnapshot(input);
    const source = normalizePartition(input.source);
    const contract = normalizeContract(input.contract);
    const collectionSlug = normalizePartition(input.collection_slug);
    const askCount = input.orders.filter(
      (order) => order.side === 'ask'
    ).length;
    const bidCount = input.orders.length - askCount;

    const startedAt = performance.now();
    let lockRequestedAt: number | null = null;
    let lockAcquiredAt: number | null = null;
    let lockWaitTimeoutSeconds: number | null = null;
    let insertMs: number | null = null;
    let phase = 'transaction';
    let outcome = 'error';

    const publish = async (
      connection: DbConnection
    ): Promise<MarketDepthSnapshotMetadata> => {
      phase = 'partition';
      await this.query(
        `INSERT INTO ${MARKET_DEPTH_COLLECTION_STATE_TABLE}
          (source, chain_id, contract, collection_slug, collection_id, latest_snapshot_id,
           latest_started_at, latest_completed_at)
         VALUES (:source, :chainId, :contract, :collectionSlug, :collectionId, NULL, NULL, NULL)
         ON DUPLICATE KEY UPDATE source=source`,
        {
          source,
          chainId: MARKET_DEPTH_CHAIN_ID,
          contract,
          collectionSlug,
          collectionId: input.collection_id ?? null
        },
        connection
      );
      const state = (
        await this.query<{
          latest_snapshot_id: string | null;
          latest_started_at: Date | null;
        }>(
          `SELECT latest_snapshot_id, latest_started_at FROM ${MARKET_DEPTH_COLLECTION_STATE_TABLE}
           WHERE source=:source AND chain_id=:chainId AND contract=:contract
             AND collection_slug=:collectionSlug FOR UPDATE`,
          {
            source,
            chainId: MARKET_DEPTH_CHAIN_ID,
            contract,
            collectionSlug
          },
          connection
        )
      )[0];
      if (
        state?.latest_started_at &&
        new Date(state.latest_started_at).getTime() >=
          input.started_at.getTime()
      ) {
        throw new StaleMarketDepthSnapshotError(
          'A newer or equal market-depth snapshot collection is already published'
        );
      }
      for (const reconciliation of input.reconciliations ?? []) {
        if (
          normalizePartition(reconciliation.source) !== source ||
          normalizeContract(reconciliation.contract) !== contract ||
          normalizePartition(reconciliation.collection_slug) !==
            collectionSlug ||
          reconciliation.prior_snapshot_id !== state?.latest_snapshot_id
        ) {
          throw new Error(
            'Snapshot reconciliation must reference the current prior partition snapshot'
          );
        }
      }

      phase = 'snapshot';
      await this.query(
        `INSERT INTO ${MARKET_DEPTH_SNAPSHOTS_TABLE}
          (id, chain, chain_id, source, contract, collection_slug, collection_id,
           schema_version, normalizer_version, started_at, completed_at,
           raw_order_count, order_count, ask_count, bid_count,
           unsupported_count, skipped_count, event_count,
           raw_archive_gzip, normalized_archive_gzip)
         VALUES
          (:id, :chain, :chainId, :source, :contract, :collectionSlug, :collectionId,
           :schemaVersion, :normalizerVersion, :startedAt, :completedAt,
           :rawOrderCount, :orderCount, :askCount, :bidCount,
           :unsupportedCount, :skippedCount, :eventCount,
           :rawArchive, :normalizedArchive)`,
        {
          id: input.id,
          chain: MARKET_DEPTH_CHAIN,
          chainId: MARKET_DEPTH_CHAIN_ID,
          source,
          contract,
          collectionSlug,
          collectionId: input.collection_id ?? null,
          schemaVersion: MARKET_DEPTH_SNAPSHOT_SCHEMA_VERSION,
          normalizerVersion: input.normalizer_version,
          startedAt: input.started_at,
          completedAt: input.completed_at,
          rawOrderCount: input.raw_order_count,
          orderCount: input.orders.length,
          askCount,
          bidCount,
          unsupportedCount: input.unsupported_count,
          skippedCount: input.skipped_count,
          eventCount: input.event_count,
          rawArchive: input.raw_archive_gzip,
          normalizedArchive: input.normalized_archive_gzip
        },
        connection
      );

      // Acquire before any current-order writes. All publishers use the same
      // partition -> archive -> global lock -> current orders sequence. The lock
      // lives in this transaction and is released by COMMIT/ROLLBACK, including
      // the first invocation that creates the row. Archive writes stay parallel;
      // never use a per-collection key for the shared PRIMARY-index contention.
      phase = 'lock_settings';
      const lockSession = (
        await this.query<{ seconds: number }>(
          'SELECT @@SESSION.innodb_lock_wait_timeout AS seconds',
          {},
          connection
        )
      )[0];
      lockWaitTimeoutSeconds = Number(lockSession.seconds);
      phase = 'lock';
      lockRequestedAt = performance.now();
      await this.query(
        `INSERT INTO ${MARKET_DEPTH_PUBLICATION_LOCKS_TABLE} (id)
         VALUES (:id) ON DUPLICATE KEY UPDATE id=id`,
        { id: PUBLICATION_LOCK_ID },
        connection
      );
      lockAcquiredAt = performance.now();
      phase = 'delete_orders';
      await this.query(
        `DELETE FROM ${MARKET_DEPTH_CURRENT_ORDERS_TABLE}
         WHERE source=:source AND chain_id=:chainId AND contract=:contract
           AND collection_slug=:collectionSlug`,
        {
          source,
          chainId: MARKET_DEPTH_CHAIN_ID,
          contract,
          collectionSlug
        },
        connection
      );
      phase = 'insert_orders';
      const insertStartedAt = performance.now();
      try {
        await this.db.bulkInsert(
          MARKET_DEPTH_CURRENT_ORDERS_TABLE,
          input.orders.map((order) =>
            orderForDb(input.id, source, contract, collectionSlug, order)
          ),
          ORDER_COLUMNS,
          undefined,
          { connection }
        );
      } finally {
        insertMs = performance.now() - insertStartedAt;
      }
      phase = 'state';
      await this.query(
        `UPDATE ${MARKET_DEPTH_COLLECTION_STATE_TABLE}
         SET collection_id=:collectionId, latest_snapshot_id=:snapshotId,
             latest_started_at=:startedAt,
             latest_completed_at=:completedAt
         WHERE source=:source AND chain_id=:chainId AND contract=:contract
           AND collection_slug=:collectionSlug`,
        {
          snapshotId: input.id,
          collectionId: input.collection_id ?? null,
          startedAt: input.started_at,
          completedAt: input.completed_at,
          source,
          chainId: MARKET_DEPTH_CHAIN_ID,
          contract,
          collectionSlug
        },
        connection
      );
      phase = 'reconciliations';
      await this.insertReconciliations(input.reconciliations ?? [], connection);
      phase = 'commit';

      return {
        id: input.id,
        chain: MARKET_DEPTH_CHAIN,
        chain_id: MARKET_DEPTH_CHAIN_ID,
        source,
        contract,
        collection_slug: collectionSlug,
        collection_id: input.collection_id ?? null,
        schema_version: MARKET_DEPTH_SNAPSHOT_SCHEMA_VERSION,
        normalizer_version: input.normalizer_version,
        started_at: input.started_at,
        completed_at: input.completed_at,
        raw_order_count: input.raw_order_count,
        order_count: input.orders.length,
        ask_count: askCount,
        bid_count: bidCount,
        unsupported_count: input.unsupported_count,
        skipped_count: input.skipped_count,
        event_count: input.event_count
      };
    };
    try {
      const result = await this.executeNativeQueriesInTransaction(publish, {
        isolationLevel: 'READ COMMITTED'
      });
      outcome = 'committed';
      return result;
    } finally {
      // Include transaction finalization: logging inside publish would omit
      // COMMIT/ROLLBACK while the shared lock is still held. An error outcome
      // does not claim that an unacknowledged COMMIT was rolled back.
      const finishedAt = performance.now();
      logger.info('[SNAPSHOT PUBLICATION]', {
        source,
        contract,
        collection_slug: collectionSlug,
        snapshot_id: input.id,
        order_count: input.orders.length,
        outcome,
        phase,
        lock_acquired: lockAcquiredAt !== null,
        lock_wait_timeout_s: lockWaitTimeoutSeconds,
        lock_wait_ms:
          lockRequestedAt === null
            ? null
            : Math.round((lockAcquiredAt ?? finishedAt) - lockRequestedAt),
        lock_held_ms:
          lockAcquiredAt === null
            ? null
            : Math.round(finishedAt - lockAcquiredAt),
        insert_ms: insertMs === null ? null : Math.round(insertMs),
        total_ms: Math.round(finishedAt - startedAt)
      });
    }
  }

  async getLatestCompletedSnapshot(
    sourceValue: string,
    contractValue: string,
    collectionSlugValue: string,
    options: MarketDepthSnapshotReadOptions = {}
  ): Promise<CurrentMarketDepthSnapshot | null> {
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) ||
        options.limit < 1 ||
        options.limit > MAX_MARKET_DEPTH_COLLECTION_ASKS)
    ) {
      throw new Error('Invalid market-depth read limit');
    }
    const params = {
      source: normalizePartition(sourceValue),
      chainId: MARKET_DEPTH_CHAIN_ID,
      contract: normalizeContract(contractValue),
      collectionSlug: normalizePartition(collectionSlugValue)
    };
    return this.executeNativeQueriesInTransaction(async (connection) => {
      const row = (
        await this.query<SnapshotRow>(
          `SELECT s.id, s.chain, s.chain_id, s.source, s.contract,
                s.collection_slug, s.collection_id, s.schema_version, s.normalizer_version,
                s.started_at, s.completed_at, s.raw_order_count, s.order_count,
                s.ask_count, s.bid_count, s.unsupported_count, s.skipped_count,
                s.event_count
         FROM ${MARKET_DEPTH_COLLECTION_STATE_TABLE} state
         INNER JOIN ${MARKET_DEPTH_SNAPSHOTS_TABLE} s ON s.id=state.latest_snapshot_id
         WHERE state.source=:source AND state.chain_id=:chainId
           AND state.contract=:contract AND state.collection_slug=:collectionSlug`,
          params,
          connection
        )
      )[0];
      if (!row) return null;

      const includePayloads = options.include_payloads ?? true;
      const selectedOrderColumns = ORDER_COLUMNS.map((column) =>
        !includePayloads &&
        (column === 'protocol_data' || column === 'source_data')
          ? `NULL AS ${column}`
          : column
      ).join(', ');
      const tokenFilter = options.token_id
        ? 'AND (token_id=:tokenId OR token_id IS NULL)'
        : '';
      const sideFilter = options.side ? 'AND side=:side' : '';
      const limitClause = options.limit === undefined ? '' : 'LIMIT :limit';
      const orders = await this.query<CurrentMarketDepthOrder>(
        `SELECT ${selectedOrderColumns} FROM ${MARKET_DEPTH_CURRENT_ORDERS_TABLE}
         WHERE snapshot_id=:snapshotId AND source=:source AND chain_id=:chainId
           AND contract=:contract AND collection_slug=:collectionSlug
           ${tokenFilter}
           ${sideFilter}
         ORDER BY side ASC, order_key ASC ${limitClause}`,
        {
          ...params,
          snapshotId: row.id,
          tokenId: options.token_id,
          side: options.side,
          limit: options.limit
        },
        connection
      );
      return {
        snapshot: mapSnapshotRow(row),
        orders: orders.map((order) => ({
          ...order,
          chain: MARKET_DEPTH_CHAIN,
          chain_id: MARKET_DEPTH_CHAIN_ID,
          criteria: parseJson(order.criteria),
          protocol_data: parseJson(order.protocol_data),
          source_data: parseJson(order.source_data),
          executable_caveats: parseJson(order.executable_caveats),
          is_executable:
            order.is_executable === null ? null : Boolean(order.is_executable),
          is_private: Boolean(order.is_private),
          start_at: order.start_at ? new Date(order.start_at) : null,
          end_at: order.end_at ? new Date(order.end_at) : null,
          observed_at: new Date(order.observed_at)
        }))
      };
    });
  }

  async getSnapshotArchive(
    snapshotId: string
  ): Promise<MarketDepthSnapshotArchive | null> {
    const row = (
      await this.query<MarketDepthSnapshotArchive>(
        `SELECT id AS snapshot_id, raw_archive_gzip, normalized_archive_gzip
         FROM ${MARKET_DEPTH_SNAPSHOTS_TABLE} WHERE id=:snapshotId`,
        { snapshotId }
      )
    )[0];
    return row
      ? {
          ...row,
          raw_archive_gzip: bufferFromDb(
            row.raw_archive_gzip,
            'raw_archive_gzip'
          ),
          normalized_archive_gzip: bufferFromDb(
            row.normalized_archive_gzip,
            'normalized_archive_gzip'
          )
        }
      : null;
  }

  async appendEvents(
    input: AppendMarketDepthEventsInput,
    executionBudget?: SqlExecutionBudget
  ): Promise<void> {
    const source = normalizePartition(input.source);
    const contract = normalizeContract(input.contract);
    const collectionSlug = normalizePartition(input.collection_slug);

    const append = async (connection: DbConnection) => {
      // Budgeted transactions own session setup/restoration and physical disposal.
      const lockWaitTimeout = executionBudget
        ? null
        : await this.prepareEventSession(connection);
      let operationFailed = false;
      try {
        await this.query(
          `INSERT INTO ${MARKET_DEPTH_CURSORS_TABLE}
          (source, chain_id, contract, collection_slug, provider_cursor,
           provider_watermark, provider_at, observed_at)
         VALUES (:source, :chainId, :contract, :collectionSlug, NULL, NULL, NULL, :observedAt)
         ON DUPLICATE KEY UPDATE source=source`,
          {
            source,
            chainId: MARKET_DEPTH_CHAIN_ID,
            contract,
            collectionSlug,
            observedAt: input.observed_at
          },
          connection
        );
        const cursor = (
          await this.query<{
            provider_cursor: string | null;
            provider_watermark: string | null;
          }>(
            `SELECT provider_cursor, provider_watermark FROM ${MARKET_DEPTH_CURSORS_TABLE}
           WHERE source=:source AND chain_id=:chainId AND contract=:contract
             AND collection_slug=:collectionSlug FOR UPDATE`,
            {
              source,
              chainId: MARKET_DEPTH_CHAIN_ID,
              contract,
              collectionSlug
            },
            connection
          )
        )[0];
        if (
          (cursor?.provider_cursor ?? null) !== input.expected_cursor ||
          (cursor?.provider_watermark ?? null) !== input.expected_watermark
        ) {
          throw new MarketDepthCursorConflictError(
            'Market-depth cursor changed before this event page was committed'
          );
        }

        const events = input.events.map((event) => ({
          ...event,
          source,
          chain: MARKET_DEPTH_CHAIN,
          chain_id: MARKET_DEPTH_CHAIN_ID,
          contract,
          collection_slug: collectionSlug,
          raw: JSON.stringify(event.raw)
        }));
        await this.db.bulkInsert(
          MARKET_DEPTH_EVENTS_TABLE,
          events,
          EVENT_COLUMNS,
          undefined,
          {
            chunkSize: 500,
            connection,
            ignoreDuplicates: true
          }
        );
        await this.query(
          `UPDATE ${MARKET_DEPTH_CURSORS_TABLE}
         SET provider_cursor=:nextCursor, provider_watermark=:watermark,
             provider_at=:providerAt, observed_at=:observedAt
         WHERE source=:source AND chain_id=:chainId AND contract=:contract
           AND collection_slug=:collectionSlug`,
          {
            nextCursor: input.next_cursor,
            watermark: input.provider_watermark,
            providerAt: input.provider_at,
            observedAt: input.observed_at,
            source,
            chainId: MARKET_DEPTH_CHAIN_ID,
            contract,
            collectionSlug
          },
          connection
        );
      } catch (error) {
        operationFailed = true;
        throw error;
      } finally {
        if (lockWaitTimeout !== null) {
          await this.restoreEventSession(
            connection,
            lockWaitTimeout,
            operationFailed
          );
        }
      }
    };
    await this.executeNativeQueriesInTransaction(
      append,
      executionBudget ? { executionBudget } : undefined
    );
  }

  private async prepareEventSession(connection: DbConnection): Promise<number> {
    const session = (
      await this.query<{ lock_wait_timeout: number }>(
        'SELECT @@SESSION.innodb_lock_wait_timeout AS lock_wait_timeout',
        {},
        connection
      )
    )[0];
    if (!session || !Number.isInteger(Number(session.lock_wait_timeout))) {
      throw new Error('Could not read market-depth session lock timeout');
    }
    await this.query('SET SESSION innodb_lock_wait_timeout=3', {}, connection);
    return Number(session.lock_wait_timeout);
  }

  private async restoreEventSession(
    connection: DbConnection,
    lockWaitTimeout: number,
    operationFailed: boolean
  ): Promise<void> {
    try {
      await this.query(
        'SET SESSION innodb_lock_wait_timeout=:lockWaitTimeout',
        { lockWaitTimeout },
        connection
      );
    } catch (error) {
      if (!operationFailed) throw error;
      // Preserve the original operation error so cursor conflicts remain
      // distinguishable. Cleanup failures after successful writes still abort.
      logger.warn(
        'Could not restore the lock timeout after a failed event write'
      );
    }
  }

  async getCursor(
    sourceValue: string,
    contractValue: string,
    collectionSlugValue: string
  ): Promise<MarketDepthCursor | null> {
    const row = (
      await this.query<MarketDepthCursor>(
        `SELECT source, chain_id, contract, collection_slug, provider_cursor,
                provider_watermark, provider_at, observed_at
         FROM ${MARKET_DEPTH_CURSORS_TABLE}
         WHERE source=:source AND chain_id=:chainId AND contract=:contract
           AND collection_slug=:collectionSlug`,
        {
          source: normalizePartition(sourceValue),
          chainId: MARKET_DEPTH_CHAIN_ID,
          contract: normalizeContract(contractValue),
          collectionSlug: normalizePartition(collectionSlugValue)
        }
      )
    )[0];
    return row
      ? {
          ...row,
          chain: MARKET_DEPTH_CHAIN,
          chain_id: MARKET_DEPTH_CHAIN_ID,
          provider_at: row.provider_at ? new Date(row.provider_at) : null,
          observed_at: new Date(row.observed_at)
        }
      : null;
  }

  async enqueueReconciliations(
    inputs: MarketDepthReconciliationInput[]
  ): Promise<void> {
    await this.insertReconciliations(inputs);
  }

  private async insertReconciliations(
    inputs: MarketDepthReconciliationInput[],
    connection?: DbConnection
  ): Promise<void> {
    if (!inputs.length) return;
    const rows = inputs.map((input) => {
      const source = normalizePartition(input.source);
      const contract = normalizeContract(input.contract);
      const collectionSlug = normalizePartition(input.collection_slug);
      return {
        id: reconciliationId(input),
        prior_snapshot_id: input.prior_snapshot_id,
        source,
        chain: MARKET_DEPTH_CHAIN,
        chain_id: MARKET_DEPTH_CHAIN_ID,
        contract,
        collection_slug: collectionSlug,
        protocol: normalizePartition(input.order.protocol),
        order_id: input.order.order_id,
        order_key: input.order.order_key,
        token_id: input.order.token_id,
        side: input.order.side,
        prior_order: JSON.stringify(input.order),
        status: 'PENDING',
        first_missing_at: input.missing_at,
        next_attempt_at: input.missing_at,
        last_attempt_at: null,
        attempt_count: 0,
        resolved_at: null,
        last_error: null
      };
    });
    await this.db.bulkInsert(
      MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE,
      rows,
      RECONCILIATION_COLUMNS,
      undefined,
      { chunkSize: 500, connection, ignoreDuplicates: true }
    );
  }

  async getDueReconciliations(
    sourceValue: string,
    contractValue: string,
    collectionSlugValue: string,
    now: Date,
    limit = 100
  ): Promise<MarketDepthReconciliation[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('Reconciliation limit must be between 1 and 500');
    }
    const rows = await this.query<ReconciliationRow>(
      `SELECT id, prior_snapshot_id, source, chain, chain_id, contract,
              collection_slug, protocol, order_id, order_key, token_id, side,
              prior_order, status, first_missing_at, next_attempt_at,
              last_attempt_at, attempt_count, resolved_at, last_error
       FROM ${MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE}
       WHERE source=:source AND chain_id=:chainId AND contract=:contract
         AND collection_slug=:collectionSlug AND status='PENDING'
         AND next_attempt_at<=:now
       ORDER BY next_attempt_at ASC, id ASC LIMIT :limit`,
      {
        source: normalizePartition(sourceValue),
        chainId: MARKET_DEPTH_CHAIN_ID,
        contract: normalizeContract(contractValue),
        collectionSlug: normalizePartition(collectionSlugValue),
        now,
        limit
      }
    );
    return rows.map((row) => ({
      ...row,
      chain: MARKET_DEPTH_CHAIN,
      chain_id: MARKET_DEPTH_CHAIN_ID,
      prior_order: normalizedOrderFromJson(row.prior_order),
      first_missing_at: new Date(row.first_missing_at),
      next_attempt_at: new Date(row.next_attempt_at),
      last_attempt_at: row.last_attempt_at
        ? new Date(row.last_attempt_at)
        : null,
      resolved_at: row.resolved_at ? new Date(row.resolved_at) : null,
      attempt_count: Number(row.attempt_count)
    }));
  }

  async markReconciliationRetry(
    input: MarketDepthReconciliationRetryInput
  ): Promise<boolean> {
    assertNonNegativeInteger(input.expected_attempt_count, 'attempt_count');
    const result = await this.query<unknown>(
      `UPDATE ${MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE}
       SET attempt_count=attempt_count+1, last_attempt_at=:attemptedAt,
           next_attempt_at=:nextAttemptAt, last_error=:lastError
       WHERE id=:id AND status='PENDING' AND attempt_count=:expectedAttemptCount`,
      {
        id: input.id,
        expectedAttemptCount: input.expected_attempt_count,
        attemptedAt: input.attempted_at,
        nextAttemptAt: input.next_attempt_at,
        lastError: input.last_error.slice(0, 4000)
      }
    );
    return this.db.getAffectedRows(result) === 1;
  }

  async resolveReconciliation(
    input: MarketDepthReconciliationResolveInput
  ): Promise<boolean> {
    assertNonNegativeInteger(input.expected_attempt_count, 'attempt_count');
    const result = await this.query<unknown>(
      `UPDATE ${MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE}
       SET status='RESOLVED', attempt_count=attempt_count+1,
           last_attempt_at=:resolvedAt, resolved_at=:resolvedAt,
           last_error=NULL
       WHERE id=:id AND status='PENDING' AND attempt_count=:expectedAttemptCount`,
      {
        id: input.id,
        expectedAttemptCount: input.expected_attempt_count,
        resolvedAt: input.resolved_at
      }
    );
    return this.db.getAffectedRows(result) === 1;
  }

  private async getPurgePartitions(
    contract: string
  ): Promise<PurgePartition[]> {
    return this.query<PurgePartition>(
      `SELECT source, collection_slug, latest_snapshot_id
       FROM ${MARKET_DEPTH_COLLECTION_STATE_TABLE}
       WHERE chain_id=:chainId AND contract=:contract
       ORDER BY source ASC, collection_slug ASC`,
      { chainId: MARKET_DEPTH_CHAIN_ID, contract }
    );
  }

  async purgeSnapshotsCompletedBefore(input: {
    contract: string;
    cutoff: Date;
    limit: number;
  }): Promise<number> {
    assertPurgeLimit(input.limit);
    const contract = normalizeContract(input.contract);
    const ids: string[] = [];
    for (const partition of await this.getPurgePartitions(contract)) {
      if (ids.length >= input.limit) break;
      // The latest snapshot and any snapshot the live book still points at
      // are kept regardless of age.
      const rows = await this.query<{ id: string }>(
        `SELECT s.id FROM ${MARKET_DEPTH_SNAPSHOTS_TABLE} s
         FORCE INDEX (idx_market_depth_snapshots_collection_completed)
         WHERE s.source=:source AND s.chain_id=:chainId AND s.contract=:contract
           AND s.collection_slug=:collectionSlug AND s.completed_at<:cutoff
           AND s.id<>:latestSnapshotId
           AND NOT EXISTS (
             SELECT 1 FROM ${MARKET_DEPTH_CURRENT_ORDERS_TABLE} c
             WHERE c.snapshot_id=s.id
           )
         ORDER BY s.completed_at ASC, s.id ASC LIMIT :limit`,
        {
          source: partition.source,
          chainId: MARKET_DEPTH_CHAIN_ID,
          contract,
          collectionSlug: partition.collection_slug,
          cutoff: input.cutoff,
          latestSnapshotId: partition.latest_snapshot_id ?? '',
          limit: input.limit - ids.length
        }
      );
      ids.push(...rows.map((row) => row.id));
    }
    if (!ids.length) return 0;
    // Re-check at deletion time so a concurrent publish cannot lose the
    // snapshot it just made current.
    const result = await this.query<unknown>(
      `DELETE FROM ${MARKET_DEPTH_SNAPSHOTS_TABLE}
       WHERE id IN (:ids) AND completed_at<:cutoff
         AND NOT EXISTS (
           SELECT 1 FROM ${MARKET_DEPTH_COLLECTION_STATE_TABLE} state
           WHERE state.latest_snapshot_id=${MARKET_DEPTH_SNAPSHOTS_TABLE}.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${MARKET_DEPTH_CURRENT_ORDERS_TABLE} c
           WHERE c.snapshot_id=${MARKET_DEPTH_SNAPSHOTS_TABLE}.id
         )`,
      { ids, cutoff: input.cutoff }
    );
    return this.db.getAffectedRows(result);
  }

  async purgeReconciliationsDueBefore(input: {
    contract: string;
    cutoff: Date;
    limit: number;
  }): Promise<number> {
    assertPurgeLimit(input.limit);
    const contract = normalizeContract(input.contract);
    const ids: string[] = [];
    for (const partition of await this.getPurgePartitions(contract)) {
      for (const status of RECONCILIATION_STATUSES) {
        if (ids.length >= input.limit) break;
        // Retried rows move next_attempt_at forward, so an old value means the
        // row was resolved or has waited unprocessed for the whole window.
        const rows = await this.query<{ id: string }>(
          `SELECT id FROM ${MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE}
           FORCE INDEX (idx_market_depth_reconciliation_due)
           WHERE source=:source AND chain_id=:chainId AND contract=:contract
             AND collection_slug=:collectionSlug AND status=:status
             AND next_attempt_at<:cutoff
           ORDER BY next_attempt_at ASC, id ASC LIMIT :limit`,
          {
            source: partition.source,
            chainId: MARKET_DEPTH_CHAIN_ID,
            contract,
            collectionSlug: partition.collection_slug,
            status,
            cutoff: input.cutoff,
            limit: input.limit - ids.length
          }
        );
        ids.push(...rows.map((row) => row.id));
      }
    }
    if (!ids.length) return 0;
    const result = await this.query<unknown>(
      `DELETE FROM ${MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE}
       WHERE id IN (:ids) AND next_attempt_at<:cutoff`,
      { ids, cutoff: input.cutoff }
    );
    return this.db.getAffectedRows(result);
  }

  async purgeEventsObservedBefore(input: {
    contract: string;
    cutoff: Date;
    after: MarketDepthEventPurgeKey | null;
    limit: number;
  }): Promise<MarketDepthEventPurgeBatch> {
    assertPurgeLimit(input.limit);
    const params = {
      chainId: MARKET_DEPTH_CHAIN_ID,
      contract: normalizeContract(input.contract),
      cutoff: input.cutoff
    };
    const afterClause = input.after
      ? 'AND (observed_at>:afterAt OR (observed_at=:afterAt AND event_id>:afterId))'
      : '';
    const candidates = await this.query<{
      event_id: string;
      order_id: string | null;
      observed_at: Date;
    }>(
      `SELECT event_id, order_id, observed_at FROM ${MARKET_DEPTH_EVENTS_TABLE}
       FORCE INDEX (idx_market_depth_events_contract_observed)
       WHERE chain_id=:chainId AND contract=:contract AND observed_at<:cutoff
         ${afterClause}
       ORDER BY observed_at ASC, event_id ASC LIMIT :limit`,
      {
        ...params,
        afterAt: input.after?.observed_at,
        afterId: input.after?.event_id,
        limit: input.limit
      }
    );
    const last = candidates.at(-1);
    if (!last) return { scanned: 0, deleted: 0, last: input.after };

    // Orders still in the live book keep their whole history: the depth API
    // applies their latest terminal event even when it predates the window.
    const orderIds = Array.from(
      new Set(
        candidates.flatMap((event) => (event.order_id ? [event.order_id] : []))
      )
    );
    const liveOrderIds = new Set(
      orderIds.length
        ? (
            await this.query<{ order_id: string }>(
              `SELECT DISTINCT order_id FROM ${MARKET_DEPTH_CURRENT_ORDERS_TABLE}
               WHERE chain_id=:chainId AND contract=:contract
                 AND order_id IN (:orderIds)`,
              { ...params, orderIds }
            )
          ).map((row) => row.order_id.toLowerCase())
        : []
    );
    const ids = candidates
      .filter(
        (event) =>
          event.order_id === null ||
          !liveOrderIds.has(event.order_id.toLowerCase())
      )
      .map((event) => event.event_id);
    let deleted = 0;
    if (ids.length) {
      const result = await this.query<unknown>(
        `DELETE FROM ${MARKET_DEPTH_EVENTS_TABLE}
         WHERE event_id IN (:ids) AND chain_id=:chainId AND contract=:contract
           AND observed_at<:cutoff`,
        { ...params, ids }
      );
      deleted = this.db.getAffectedRows(result);
    }
    return {
      scanned: candidates.length,
      deleted,
      last: { observed_at: new Date(last.observed_at), event_id: last.event_id }
    };
  }
}

export const marketDepthDb = new MarketDepthDb(dbSupplier);
