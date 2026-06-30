import { WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE } from '@/constants';
import { DbPoolName } from '@/db-query.options';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import { sqs } from '@/sqs';
import { Time } from '@/time';
import { randomUUID } from 'crypto';
import { dropsDb as defaultDropsDb, DropsDb } from './drops.db';

export const WAVE_DROP_METRICS_DIRTY_REFRESH_QUEUE_NAME =
  'wave-drop-metrics-refresh-dirty.fifo';
export const WAVE_DROP_METRICS_DIRTY_REFRESH_MESSAGE_GROUP_ID =
  'wave-drop-metrics-refresh-dirty';

const WAVE_DROP_METRICS_DEFAULT_REFRESH_BATCH_SIZE = 10;
const WAVE_DROP_METRICS_MAX_REFRESH_BATCH_SIZE = 50;
const WAVE_DROP_METRICS_MAX_REFRESH_ATTEMPTS = 5;

export const WaveDropMetricsDirtyRefreshReason = {
  DROP_CHANGED: 'DROP_CHANGED',
  DROP_DELETED: 'DROP_DELETED',
  REPAIR: 'REPAIR'
} as const;

export type WaveDropMetricsDirtyRefreshReason =
  (typeof WaveDropMetricsDirtyRefreshReason)[keyof typeof WaveDropMetricsDirtyRefreshReason];

export interface RefreshDirtyWaveDropMetricsOptions {
  readonly batchSize?: number | undefined;
  readonly maxBatches?: number | undefined;
}

export interface RefreshDirtyWaveDropMetricsResult {
  readonly batches: number;
  readonly waves: number;
  readonly hasMore: boolean;
}

interface DirtyWaveDropMetricsRefreshRequestRow {
  readonly wave_id: string;
  readonly dirty_at: number | string;
}

export class WaveDropMetricsRefreshService extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  public constructor(
    sqlExecutorGetter: () => SqlExecutor = dbSupplier,
    private readonly dropsDb: DropsDb = defaultDropsDb
  ) {
    super(sqlExecutorGetter);
  }

  public async refreshDropMetricsForWaveIds(
    waveIds: string[],
    ctx: RequestContext = {}
  ): Promise<void> {
    const distinctWaveIds = this.distinctWaveIds(waveIds);
    if (!distinctWaveIds.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->refreshDropMetricsForWaveIds`);
    try {
      for (
        let i = 0;
        i < distinctWaveIds.length;
        i += WAVE_DROP_METRICS_MAX_REFRESH_BATCH_SIZE
      ) {
        const waveIdsChunk = distinctWaveIds.slice(
          i,
          i + WAVE_DROP_METRICS_MAX_REFRESH_BATCH_SIZE
        );
        await this.dropsDb.resyncDropCountsForWaves(waveIdsChunk, ctx, {
          forcePool: DbPoolName.WRITE
        });
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->refreshDropMetricsForWaveIds`);
    }
  }

  public async refreshDropMetricsForWaveIdsBestEffort(
    waveIds: string[],
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      await this.refreshDropMetricsForWaveIds(waveIds, ctx);
    } catch (error) {
      this.logger.error(
        `Failed to refresh drop metrics for ${waveIds.length}`,
        {
          waveIds,
          error
        }
      );
    }
  }

  public async markWaveDropMetricsDirty(
    waveIds: string[],
    reason: WaveDropMetricsDirtyRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    const distinctWaveIds = this.distinctWaveIds(waveIds);
    if (!distinctWaveIds.length) {
      return;
    }
    ctx.timer?.start(`${this.constructor.name}->markWaveDropMetricsDirty`);
    try {
      const now = Time.currentMillis();
      const params = distinctWaveIds.reduce<Record<string, string | number>>(
        (acc, waveId, i) => {
          acc[`waveId${i}`] = waveId;
          acc[`reason${i}`] = reason;
          acc[`dirtyAt${i}`] = now;
          acc[`createdAt${i}`] = now;
          acc[`updatedAt${i}`] = now;
          return acc;
        },
        {}
      );
      await this.db.execute(
        `
        insert into ${WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE}
          (wave_id, reason, dirty_at, attempts, last_error, created_at, updated_at)
        values ${distinctWaveIds
          .map(
            (_, i) =>
              `(:waveId${i}, :reason${i}, :dirtyAt${i}, 0, null, :createdAt${i}, :updatedAt${i})`
          )
          .join(', ')}
        as new
        on duplicate key update
          reason = new.reason,
          -- Re-dirties during a drain must survive the captured-version delete.
          -- Treat dirty_at as a version; same-millisecond writes can move it ahead of wall-clock time.
          dirty_at = greatest(
            new.dirty_at,
            ${WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE}.dirty_at + 1
          ),
          attempts = 0,
          last_error = null,
          updated_at = new.updated_at
        `,
        params,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->markWaveDropMetricsDirty`);
    }
  }

  public async markWaveDropMetricsDirtyBestEffort(
    waveIds: string[],
    reason: WaveDropMetricsDirtyRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      await this.markWaveDropMetricsDirty(waveIds, reason, ctx);
    } catch (error) {
      this.logger.error(
        `Failed to mark wave drop metrics dirty for ${waveIds.length}`,
        {
          waveIds,
          reason,
          error
        }
      );
      if (ctx.connection) {
        // Keep write transactions short; post-commit callers issue a second
        // best-effort dirty mark and wakeup when the transaction succeeds.
        return;
      }
      await this.refreshDropMetricsForWaveIdsBestEffort(waveIds, ctx);
    }
  }

  public async requestWaveDropMetricsRefreshBestEffort(
    waveIds: string[],
    reason: WaveDropMetricsDirtyRefreshReason,
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      await this.markWaveDropMetricsDirty(waveIds, reason, ctx);
    } catch (error) {
      this.logger.error(
        `Failed to persist dirty wave drop metrics refresh request for ${waveIds.length}`,
        {
          waveIds,
          reason,
          error
        }
      );
      await this.refreshDropMetricsForWaveIdsBestEffort(waveIds, ctx);
      return;
    }
    await this.enqueueDirtyWaveDropMetricsRefreshBestEffort(ctx);
  }

  public async enqueueDirtyWaveDropMetricsRefresh(
    ctx: RequestContext = {}
  ): Promise<void> {
    ctx.timer?.start(
      `${this.constructor.name}->enqueueDirtyWaveDropMetricsRefresh`
    );
    try {
      await sqs.sendToQueueName({
        queueName: WAVE_DROP_METRICS_DIRTY_REFRESH_QUEUE_NAME,
        messageGroupId: WAVE_DROP_METRICS_DIRTY_REFRESH_MESSAGE_GROUP_ID,
        message: {
          mode: 'DIRTY',
          requestedAt: Time.currentMillis(),
          nonce: randomUUID()
        }
      });
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->enqueueDirtyWaveDropMetricsRefresh`
      );
    }
  }

  public async enqueueDirtyWaveDropMetricsRefreshBestEffort(
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      await this.enqueueDirtyWaveDropMetricsRefresh(ctx);
    } catch (error) {
      this.logger.error(`Failed to enqueue dirty wave drop metrics refresh`, {
        error
      });
    }
  }

  public async refreshDirtyWaveDropMetrics(
    options: RefreshDirtyWaveDropMetricsOptions = {},
    ctx: RequestContext = {}
  ): Promise<RefreshDirtyWaveDropMetricsResult> {
    const batchSize = Math.max(
      1,
      Math.min(
        WAVE_DROP_METRICS_MAX_REFRESH_BATCH_SIZE,
        options.batchSize ?? WAVE_DROP_METRICS_DEFAULT_REFRESH_BATCH_SIZE
      )
    );
    const maxBatches = Math.max(
      1,
      options.maxBatches ?? Number.MAX_SAFE_INTEGER
    );
    let batches = 0;
    let waves = 0;
    let hasMore = false;
    const failedWaveIds = new Set<string>();

    for (;;) {
      // Successful rows are deleted; only failures need to be skipped for the
      // rest of this invocation so the IN-list stays bounded by failures.
      const rows = await this.getDirtyWaveDropMetricsRefreshRequests(
        batchSize,
        Array.from(failedWaveIds),
        ctx
      );
      if (!rows.length) {
        hasMore = false;
        break;
      }
      for (const row of rows) {
        const succeeded = await this.processDirtyWaveDropMetricsRefreshRequest(
          row,
          ctx
        );
        if (!succeeded) {
          failedWaveIds.add(row.wave_id);
        }
      }
      batches += 1;
      waves += rows.length;
      if (batches >= maxBatches) {
        hasMore = await this.hasDirtyWaveDropMetricsRefreshRequests(
          Array.from(failedWaveIds),
          ctx
        );
        break;
      }
      if (rows.length < batchSize) {
        hasMore = false;
        break;
      }
    }

    return {
      batches,
      waves,
      hasMore
    };
  }

  private async processDirtyWaveDropMetricsRefreshRequest(
    row: DirtyWaveDropMetricsRefreshRequestRow,
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      await this.refreshDropMetricsForWaveIds([row.wave_id], ctx);
      await this.deleteDirtyWaveDropMetricsRefreshRequests([row], ctx);
      return true;
    } catch (error) {
      await this.recordDirtyWaveDropMetricsRefreshFailure([row], error, ctx);
      this.logger.error(`Failed to refresh dirty wave drop metrics`, {
        waveId: row.wave_id,
        dirtyAt: row.dirty_at,
        error
      });
      return false;
    }
  }

  private async getDirtyWaveDropMetricsRefreshRequests(
    batchSize: number,
    excludedWaveIds: string[],
    ctx: RequestContext
  ): Promise<DirtyWaveDropMetricsRefreshRequestRow[]> {
    const excludedWaveIdParams = excludedWaveIds.reduce<Record<string, string>>(
      (acc, waveId, i) => {
        acc[`excludedWaveId${i}`] = waveId;
        return acc;
      },
      {}
    );
    const params: Record<string, string | number> = {
      batchSize,
      maxAttempts: WAVE_DROP_METRICS_MAX_REFRESH_ATTEMPTS,
      ...excludedWaveIdParams
    };
    const clauses = [
      // Park poison rows until another write re-dirties the wave and resets attempts.
      'attempts < :maxAttempts',
      ...(excludedWaveIds.length
        ? [
            `wave_id not in (${excludedWaveIds
              .map((_, i) => `:excludedWaveId${i}`)
              .join(', ')})`
          ]
        : [])
    ];
    return this.db.execute<DirtyWaveDropMetricsRefreshRequestRow>(
      `
      select wave_id, dirty_at
      from ${WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE}
      where ${clauses.join(' and ')}
      order by dirty_at asc, wave_id asc
      limit :batchSize
      `,
      params,
      {
        wrappedConnection: ctx.connection,
        // Dirty rows are inserted on the primary inside the write transaction.
        // The refresher must read primary too, or replica lag can delay work.
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private async hasDirtyWaveDropMetricsRefreshRequests(
    excludedWaveIds: string[],
    ctx: RequestContext
  ): Promise<boolean> {
    const excludedWaveIdParams = excludedWaveIds.reduce<Record<string, string>>(
      (acc, waveId, i) => {
        acc[`excludedWaveId${i}`] = waveId;
        return acc;
      },
      {}
    );
    const params: Record<string, string | number> = {
      maxAttempts: WAVE_DROP_METRICS_MAX_REFRESH_ATTEMPTS,
      ...excludedWaveIdParams
    };
    const clauses = [
      'attempts < :maxAttempts',
      ...(excludedWaveIds.length
        ? [
            `wave_id not in (${excludedWaveIds
              .map((_, i) => `:excludedWaveId${i}`)
              .join(', ')})`
          ]
        : [])
    ];
    const rows = await this.db.execute<{ readonly wave_id: string }>(
      `
      select wave_id
      from ${WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE}
      where ${clauses.join(' and ')}
      limit 1
      `,
      params,
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
    return rows.length > 0;
  }

  private async deleteDirtyWaveDropMetricsRefreshRequests(
    rows: DirtyWaveDropMetricsRefreshRequestRow[],
    ctx: RequestContext
  ): Promise<void> {
    if (!rows.length) {
      return;
    }
    await this.db.execute(
      `
      delete from ${WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE}
      where ${this.capturedDirtyRowsWhere(rows)}
      `,
      this.capturedDirtyRowsParams(rows),
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private async recordDirtyWaveDropMetricsRefreshFailure(
    rows: DirtyWaveDropMetricsRefreshRequestRow[],
    error: unknown,
    ctx: RequestContext
  ): Promise<void> {
    if (!rows.length) {
      return;
    }
    await this.db.execute(
      `
      update ${WAVE_DROP_METRICS_REFRESH_REQUESTS_TABLE}
      set
        attempts = attempts + 1,
        last_error = :lastError,
        updated_at = :updatedAt
      where ${this.capturedDirtyRowsWhere(rows)}
      `,
      {
        ...this.capturedDirtyRowsParams(rows),
        lastError: this.errorToString(error).slice(0, 2000),
        updatedAt: Time.currentMillis()
      },
      {
        wrappedConnection: ctx.connection,
        forcePool: DbPoolName.WRITE
      }
    );
  }

  private capturedDirtyRowsWhere(
    rows: DirtyWaveDropMetricsRefreshRequestRow[]
  ): string {
    return `(wave_id, dirty_at) in (${rows
      .map((_, i) => `(:dirtyWaveId${i}, :dirtyAt${i})`)
      .join(', ')})`;
  }

  private capturedDirtyRowsParams(
    rows: DirtyWaveDropMetricsRefreshRequestRow[]
  ): Record<string, string | number> {
    return rows.reduce<Record<string, string | number>>((acc, row, i) => {
      acc[`dirtyWaveId${i}`] = row.wave_id;
      acc[`dirtyAt${i}`] = this.toNumber(row.dirty_at);
      return acc;
    }, {});
  }

  private distinctWaveIds(waveIds: string[]): string[] {
    return Array.from(new Set(waveIds)).filter(Boolean);
  }

  private errorToString(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  private toNumber(value: number | string | null | undefined): number {
    if (value === null || value === undefined) {
      return 0;
    }
    return Number(value) || 0;
  }
}

export const waveDropMetricsRefreshService =
  new WaveDropMetricsRefreshService();
