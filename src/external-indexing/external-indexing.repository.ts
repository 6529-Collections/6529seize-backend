import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { RequestContext } from '../request.context';
import {
  EXTERNAL_INDEXED_CONTRACTS_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  EXTERNAL_INDEXED_TRANSFERS_TABLE
} from '@/constants';
import {
  ExternalIndexedContractEntity,
  IndexedContractStandard,
  IndexedContractStatus
} from '../entities/IExternalIndexedContract';
import { ExternalIndexedOwnership721HistoryEntity } from '../entities/IExternalIndexedOwnership721History';
import { ExternalIndexedOwnership721Entity } from '../entities/IExternalIndexedOwnership721';
import { Time } from '../time';
import { ExternalIndexedTransfersEntity } from '../entities/IExternalIndexedTransfer';

export class ExternalIndexingRepository extends LazyDbAccessCompatibleService {
  public async lockNextWaitingSnapshotJob(
    {
      snapshot_lock_owner,
      snapshot_target_block,
      now_ms
    }: {
      snapshot_lock_owner: string;
      snapshot_target_block: number;
      now_ms: number;
    },
    ctx: RequestContext
  ): Promise<{
    partition: string;
    chain: number;
    contract: string;
    at_block: number;
  } | null> {
    ctx.timer?.start(`${this.constructor.name}->lockNextWaitingSnapshotJob`);
    try {
      const updated = await this.db
        .execute(
          `
        UPDATE ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c
        JOIN (
          SELECT \`partition\`
          FROM ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
          WHERE (
                  (status = '${IndexedContractStatus.WAITING_FOR_SNAPSHOTTING}' AND snapshot_lock_owner IS NULL)
               OR (status = '${IndexedContractStatus.SNAPSHOTTING}'
                   AND snapshot_lock_owner IS NOT NULL
                   AND snapshot_lock_at <= :stale_before_ms)
                )
            AND last_indexed_block <= :snapshot_target_block
          ORDER BY
            CASE WHEN status='${IndexedContractStatus.WAITING_FOR_SNAPSHOTTING}' THEN 0 ELSE 1 END,
            updated_at ASC
          LIMIT 1
        ) pick ON pick.partition = c.partition
        SET c.status                = '${IndexedContractStatus.SNAPSHOTTING}',
            c.last_event_time       = :now_ms,
            c.snapshot_lock_owner   = :snapshot_lock_owner,
            c.snapshot_lock_at      = :now_ms,
            c.snapshot_target_block = :snapshot_target_block,
            c.updated_at            = :now_ms
        `,
          {
            snapshot_lock_owner,
            snapshot_target_block,
            now_ms,
            stale_before_ms: Time.millis(now_ms).minusMinutes(16).toMillis()
          }
        )
        .then((res) => this.getAffetedRows(res));

      if (updated !== 1) return null;

      const row = await this.db.oneOrNull<{
        partition: string;
        chain: number;
        contract: string;
        snapshot_target_block: number | null;
      }>(
        `
      SELECT \`partition\`, chain, contract, snapshot_target_block
      FROM ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
      WHERE snapshot_lock_owner = :snapshot_lock_owner
        AND snapshot_lock_at = :now_ms
        AND status = '${IndexedContractStatus.SNAPSHOTTING}'
      LIMIT 1
      `,
        { snapshot_lock_owner, now_ms }
      );

      if (!row) return null;

      return {
        partition: row.partition,
        chain: row.chain,
        contract: row.contract,
        at_block: row.snapshot_target_block ?? snapshot_target_block
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->lockNextWaitingSnapshotJob`);
    }
  }

  public async upsertOrSelectCollection(
    {
      chain,
      contract
    }: {
      chain: number;
      contract: string;
    },
    ctx: RequestContext
  ): Promise<ExternalIndexedContractEntity> {
    const timerKey = `${this.constructor.name}->upsertOrSelectCollection`;
    ctx.timer?.start(timerKey);
    try {
      const partition = `${chain}:${contract.toLowerCase()}`;
      const now_ms = Time.currentMillis();

      await this.db.execute(
        `
      INSERT INTO ${EXTERNAL_INDEXED_CONTRACTS_TABLE} (
        \`partition\`,
        chain,
        contract,
        status,
        last_indexed_block,
        safe_head_block,
        last_event_time,
        indexed_since_block,
        lag_blocks,
        lag_seconds,
        snapshot_lock_owner,
        snapshot_lock_at,
        snapshot_target_block,
        created_at,
        updated_at
      ) VALUES (
        :partition,
        :chain,
        :contract_lc,
        '${IndexedContractStatus.WAITING_FOR_SNAPSHOTTING}',
        0,
        0,
        :now_ms,
        0,
        0,
        0,
        NULL,
        NULL,
        NULL,
        :now_ms,
        :now_ms
      )
      ON DUPLICATE KEY UPDATE
        \`partition\` = \`partition\`
      `,
        {
          partition,
          chain,
          contract_lc: contract.toLowerCase(),
          now_ms
        },
        { wrappedConnection: ctx.connection }
      );

      return (await this.db.oneOrNull<ExternalIndexedContractEntity>(
        `
      SELECT
        *
      FROM ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
      WHERE \`partition\` = :partition
      LIMIT 1
      `,
        { partition },
        { wrappedConnection: ctx.connection }
      ))!;
    } finally {
      ctx.timer?.stop(timerKey);
    }
  }

  public async commitSnapshotSuccess(
    args: {
      partition: string;
      at_block: number;
      lock_owner: string;
      last_event_time: number;
      standard: IndexedContractStandard;
      adapter: string | null;
      total_supply: number | null;
      lag_blocks: number;
      lag_seconds: number;
      collection_name: string | null;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    ctx.timer?.start(`${this.constructor.name}->commitSnapshotSuccess`);
    try {
      const affectedRows = await this.db
        .execute(
          `
            UPDATE ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
            SET status                = '${IndexedContractStatus.LIVE_TAILING}',
                standard              = :standard,
                adapter               = :adapter,
                total_supply          = :total_supply,
                last_indexed_block    = :at_block,
                safe_head_block       = :at_block,
                last_event_time       = :last_event_time,
                indexed_since_block   = IF(indexed_since_block = 0, :at_block, indexed_since_block),
                lag_blocks            = :lag_blocks,
                lag_seconds           = :lag_seconds,
                snapshot_lock_owner   = NULL,
                snapshot_lock_at      = NULL,
                snapshot_target_block = NULL,
                collection_name       = :collection_name,
                error_message         = NULL,          -- ✅ clear error on success
                updated_at            = :last_event_time
            WHERE \`partition\` = :partition
              AND status = '${IndexedContractStatus.SNAPSHOTTING}'
              AND snapshot_lock_owner = :lock_owner
              AND snapshot_target_block = :at_block
          `,
          args
        )
        .then((res) => this.getAffetedRows(res));
      return affectedRows === 1;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->commitSnapshotSuccess`);
    }
  }

  public async setIndexedSinceIfEmpty(
    {
      partition,
      at_block
    }: {
      partition: string;
      at_block: number;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    ctx.timer?.start(`${this.constructor.name}->setIndexedSinceIfEmpty`);
    try {
      const affectedRows = await this.db
        .execute(
          `
            UPDATE ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
            SET indexed_since_block = :at_block, updated_at = :now_ms
            WHERE \`partition\` = :partition
              AND indexed_since_block = 0
          `,
          { partition, at_block, now_ms: Time.currentMillis() }
        )
        .then((res) => {
          return this.getAffetedRows(res);
        });
      return affectedRows === 1;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->setIndexedSinceIfEmpty`);
    }
  }

  public async failSnapshotAndUnlockWithMessage(
    {
      partition,
      lock_owner,
      last_event_time,
      error_message
    }: {
      partition: string;
      lock_owner: string;
      last_event_time: number;
      error_message: string;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    ctx.timer?.start(
      `${this.constructor.name}->failSnapshotAndUnlockWithMessage`
    );
    try {
      const affectedRows = await this.db
        .execute(
          `
            UPDATE ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
            SET status                = '${IndexedContractStatus.ERROR_SNAPSHOTTING}',
                last_event_time       = :last_event_time,
                snapshot_lock_owner   = NULL,
                snapshot_lock_at      = NULL,
                snapshot_target_block = NULL,
                error_message         = :error_message,
                updated_at            = :last_event_time
            WHERE \`partition\` = :partition
              AND status = '${IndexedContractStatus.SNAPSHOTTING}'
              AND snapshot_lock_owner = :lock_owner
          `,
          { partition, lock_owner, last_event_time, error_message }
        )
        .then((res) => this.getAffetedRows(res));
      return affectedRows === 1;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->failSnapshotAndUnlockWithMessage`
      );
    }
  }

  public async markUnindexableWithMessage(
    {
      partition,
      last_event_time,
      error_message
    }: {
      partition: string;
      last_event_time: number;
      error_message: string;
    },
    ctx: RequestContext
  ): Promise<boolean> {
    ctx.timer?.start(`${this.constructor.name}->markUnindexableWithMessage`);
    try {
      const affectedRows = await this.db
        .execute(
          `
            UPDATE ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
            SET status                = '${IndexedContractStatus.UNINDEXABLE}',
                last_event_time       = :last_event_time,
                snapshot_lock_owner   = NULL,
                snapshot_lock_at      = NULL,
                snapshot_target_block = NULL,
                error_message         = :error_message,     -- ✅ reason why
                updated_at            = :last_event_time
            WHERE \`partition\` = :partition
          `,
          { partition, last_event_time, error_message }
        )
        .then((res) => this.getAffetedRows(res));
      return affectedRows === 1;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->markUnindexableWithMessage`);
    }
  }

  async upsertOwners(
    owners: ExternalIndexedOwnership721Entity[],
    ctx?: RequestContext
  ): Promise<void> {
    if (!owners.length) return;

    await this.db.bulkUpsert(
      EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
      owners,
      [
        'partition',
        'token_id',
        'owner',
        'since_block',
        'since_time',
        'sale_epoch_start_block',
        'sale_epoch_tx',
        'free_transfers_since_epoch',
        'created_at',
        'updated_at'
      ],
      [
        'owner',
        'since_block',
        'since_time',
        'sale_epoch_start_block',
        'sale_epoch_tx',
        'free_transfers_since_epoch',
        'updated_at'
      ],
      ctx,
      { chunkSize: 1000 }
    );
  }

  async upsertOwnersHistory(
    owners: ExternalIndexedOwnership721HistoryEntity[],
    ctx?: RequestContext
  ): Promise<void> {
    if (!owners.length) return;

    await this.db.bulkUpsert(
      EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
      owners,
      [
        'partition',
        'token_id',
        'block_number',
        'log_index',
        'owner',
        'since_block',
        'since_time',
        'acquired_as_sale',
        'sale_epoch_start_block',
        'sale_epoch_tx',
        'created_at',
        'updated_at'
      ],
      [],
      ctx,
      { chunkSize: 1000 }
    );
  }

  public async findLiveTailingCollections(
    limit = 50,
    ctx?: RequestContext
  ): Promise<
    Array<{
      partition: string;
      chain: number;
      contract: string;
      safe_head_block: number;
      last_indexed_block: number;
    }>
  > {
    ctx?.timer?.start(`${this.constructor.name}->findLiveTailingCollections`);
    try {
      const rows = await this.db.execute<{
        partition: string;
        chain: number;
        contract: string;
        safe_head_block: number | null;
        last_indexed_block: number | null;
      }>(
        `
      SELECT \`partition\`, chain, contract,
             COALESCE(safe_head_block, 0)    AS safe_head_block,
             COALESCE(last_indexed_block, 0) AS last_indexed_block
      FROM ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
      WHERE status = '${IndexedContractStatus.LIVE_TAILING}'
      ORDER BY updated_at ASC
      LIMIT :limit
      `,
        { limit }
      );
      return rows.map((r) => ({
        partition: r.partition,
        chain: r.chain,
        contract: r.contract,
        safe_head_block: r.safe_head_block ?? 0,
        last_indexed_block: r.last_indexed_block ?? 0
      }));
    } finally {
      ctx?.timer?.stop(`${this.constructor.name}->findLiveTailingCollections`);
    }
  }

  public async advanceHeadsIfNotSnapshotting(
    args: {
      partition: string;
      to_block: number;
      lag_blocks: number;
      lag_seconds: number;
      now_ms?: number;
    },
    ctx?: RequestContext
  ): Promise<boolean> {
    const now_ms = args.now_ms ?? Time.currentMillis();
    const { partition, to_block, lag_blocks, lag_seconds } = args;
    ctx?.timer?.start(
      `${this.constructor.name}->advanceHeadsIfNotSnapshotting`
    );
    try {
      const affected = await this.db
        .execute(
          `
        UPDATE ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
        SET last_indexed_block = :to_block,
            safe_head_block    = :to_block,
            last_event_time    = :now_ms,
            lag_blocks         = :lag_blocks,
            lag_seconds        = :lag_seconds,
            updated_at         = :now_ms
        WHERE \`partition\` = :partition
          AND status <> '${IndexedContractStatus.SNAPSHOTTING}'
        `,
          { partition, to_block, lag_blocks, lag_seconds, now_ms }
        )
        .then((res) => this.getAffetedRows(res));
      return affected === 1;
    } finally {
      ctx?.timer?.stop(
        `${this.constructor.name}->advanceHeadsIfNotSnapshotting`
      );
    }
  }

  public async refreshLagMetrics(
    args: {
      partition: string;
      lag_blocks: number;
      lag_seconds: number;
      now_ms?: number;
    },
    ctx?: RequestContext
  ): Promise<void> {
    const now_ms = args.now_ms ?? Time.currentMillis();
    const { partition, lag_blocks, lag_seconds } = args;
    ctx?.timer?.start(`${this.constructor.name}->refreshLagMetrics`);
    try {
      await this.db.execute(
        `
      UPDATE ${EXTERNAL_INDEXED_CONTRACTS_TABLE}
      SET last_event_time = :now_ms,
          lag_blocks      = :lag_blocks,
          lag_seconds     = :lag_seconds,
          updated_at      = :now_ms
      WHERE \`partition\` = :partition
      `,
        { partition, lag_blocks, lag_seconds, now_ms }
      );
    } finally {
      ctx?.timer?.stop(`${this.constructor.name}->refreshLagMetrics`);
    }
  }

  public async upsertTransfers(
    transfers: ExternalIndexedTransfersEntity[],
    ctx?: RequestContext
  ): Promise<void> {
    if (!transfers.length) return;

    await this.db.bulkUpsert(
      EXTERNAL_INDEXED_TRANSFERS_TABLE,
      transfers,
      [
        'partition',
        'block_number',
        'log_index',
        'chain',
        'contract',
        'token_id',
        'from',
        'to',
        'amount',
        'is_monetary_sale',
        'tx_hash',
        'time',
        'sale_epoch_start',
        'created_at',
        'updated_at'
      ],
      ['is_monetary_sale', 'sale_epoch_start', 'updated_at'],
      ctx,
      { chunkSize: 1000 }
    );
  }

  private getAffetedRows(result: any): number {
    return result && typeof result === 'object' && 'affectedRows' in result
      ? result.affectedRows
      : Array.isArray(result) && typeof (result as any)[1] === 'number'
        ? (result as any)[1] // defensive: some wrappers expose index 1
        : 0;
  }

  async findCollectionInfo(
    { partition }: { partition: string },
    ctx: RequestContext
  ): Promise<ExternalIndexedContractEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->findCollectionInfo`);
      return this.db.oneOrNull(
        `select * from ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c where c.partition = :partition`,
        { partition },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findCollectionInfo`);
    }
  }

  async getAllTokenNumbersForCollection(
    param: { partition: string },
    ctx: RequestContext
  ): Promise<Set<string>> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getAllTokenNumbersForCollection`
      );
      const tokenIds = await this.db
        .execute<{
          token_id: string;
        }>(
          `select o.token_id from ${EXTERNAL_INDEXED_OWNERSHIP_721_TABLE} o where o.partition = :partition`,
          param,
          { wrappedConnection: ctx.connection }
        )
        .then((res) => res.map((it) => it.token_id));
      return new Set<string>(tokenIds);
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getAllTokenNumbersForCollection`
      );
    }
  }
}

export const externalIndexingRepository = new ExternalIndexingRepository(
  dbSupplier
);
