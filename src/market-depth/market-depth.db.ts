import { createHash } from 'node:crypto';
import { DbPoolName } from '@/db-query.options';
import {
  MARKET_DEPTH_COLLECTION_STATE_TABLE,
  MARKET_DEPTH_CURRENT_ORDERS_TABLE,
  MARKET_DEPTH_CURSORS_TABLE,
  MARKET_DEPTH_EVENTS_TABLE,
  MARKET_DEPTH_RECONCILIATION_QUEUE_TABLE,
  MARKET_DEPTH_SNAPSHOTS_TABLE
} from '@/constants/db-tables';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
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
  MarketDepthCursor,
  MarketDepthJsonValue,
  MarketDepthReconciliation,
  MarketDepthReconciliationInput,
  MarketDepthReconciliationResolveInput,
  MarketDepthReconciliationRetryInput,
  MarketDepthSnapshotArchive,
  MarketDepthSnapshotMetadata,
  MarketDepthSnapshotReadOptions,
  NormalizedMarketDepthOrder,
  PublishMarketDepthSnapshotInput
} from './market-depth.types';

type DbConnection = ConnectionWrapper<unknown>;

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

    return this.executeNativeQueriesInTransaction(async (connection) => {
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
      await this.db.bulkInsert(
        MARKET_DEPTH_CURRENT_ORDERS_TABLE,
        input.orders.map((order) =>
          orderForDb(input.id, source, contract, collectionSlug, order)
        ),
        ORDER_COLUMNS,
        undefined,
        { connection }
      );
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
      await this.insertReconciliations(input.reconciliations ?? [], connection);

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
    });
  }

  async getLatestCompletedSnapshot(
    sourceValue: string,
    contractValue: string,
    collectionSlugValue: string,
    options: MarketDepthSnapshotReadOptions = {}
  ): Promise<CurrentMarketDepthSnapshot | null> {
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
      const orders = await this.query<CurrentMarketDepthOrder>(
        `SELECT ${selectedOrderColumns} FROM ${MARKET_DEPTH_CURRENT_ORDERS_TABLE}
         WHERE snapshot_id=:snapshotId AND source=:source AND chain_id=:chainId
           AND contract=:contract AND collection_slug=:collectionSlug
           ${tokenFilter}
         ORDER BY side ASC, order_key ASC`,
        { ...params, snapshotId: row.id, tokenId: options.token_id },
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

  async appendEvents(input: AppendMarketDepthEventsInput): Promise<void> {
    const source = normalizePartition(input.source);
    const contract = normalizeContract(input.contract);
    const collectionSlug = normalizePartition(input.collection_slug);

    await this.executeNativeQueriesInTransaction(async (connection) => {
      const session = (
        await this.query<{ lock_wait_timeout: number }>(
          'SELECT @@SESSION.innodb_lock_wait_timeout AS lock_wait_timeout',
          {},
          connection
        )
      )[0];
      await this.query(
        'SET SESSION innodb_lock_wait_timeout=3',
        {},
        connection
      );
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
      } finally {
        await this.query(
          'SET SESSION innodb_lock_wait_timeout=:lockWaitTimeout',
          { lockWaitTimeout: Number(session.lock_wait_timeout) },
          connection
        );
      }
    });
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
}

export const marketDepthDb = new MarketDepthDb(dbSupplier);
