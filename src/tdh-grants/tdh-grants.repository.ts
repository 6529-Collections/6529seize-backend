import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import {
  TdhGrantEntity,
  TdhGrantStatus,
  TdhGrantTokenMode
} from '../entities/ITdhGrant';
import { RequestContext } from '../request.context';
import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  IDENTITIES_TABLE,
  TDH_GRANT_TOKENS_TABLE,
  TDH_GRANTS_TABLE,
  X_TDH_COEFFICIENT
} from '../constants';
import { Time } from '../time';
import { Logger } from '../logging';
import { TdhGrantTokenEntity } from '../entities/ITdhGrantToken';
import { bulkInsert } from '../db/my-sql.helpers';
import { numbers } from '../numbers';
import { PageSortDirection } from '../api-serverless/src/page-request';

export type GrantWithCap = TdhGrantEntity & { grantor_x_tdh_rate: number };

export class TdhGrantsRepository extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  public async lockOldestPendingGrant(
    ctx: RequestContext
  ): Promise<(TdhGrantEntity & { tokens: string[] }) | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->lockOldestPendingGrant`);
      const connection = ctx.connection;
      if (!connection) {
        throw new Error(`Can not acquire db locks without a transaction`);
      }
      const grant = await this.db.oneOrNull<TdhGrantEntity>(
        `
      select * from ${TDH_GRANTS_TABLE} where status = '${TdhGrantStatus.PENDING}' order by updated_at limit 1 for update skip locked
    `,
        undefined,
        { wrappedConnection: connection }
      );
      if (!grant) {
        return null;
      }
      const now = Time.currentMillis();
      await this.db.execute(
        `update ${TDH_GRANTS_TABLE} set updated_at = :now where id = :grant_id`,
        { now, grant_id: grant.id },
        { wrappedConnection: connection }
      );
      const tokens: string[] = [];
      if (grant.tokenset_id) {
        await this.db
          .execute<{
            token_id: string;
          }>(
            `select token_id from ${TDH_GRANT_TOKENS_TABLE} where tokenset_id = :tokenset_id`,
            { tokenset_id: grant.tokenset_id },
            { wrappedConnection: connection }
          )
          .then((res) => res.forEach((it) => tokens.push(it.token_id)));
      }
      return { ...grant, tokens, updated_at: now };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->lockOldestPendingGrant`);
    }
  }

  public async insertGrant(
    tdhGrantEntity: TdhGrantEntity,
    tokens: TdhGrantTokenEntity[],
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertGrant`);
    await this.db.execute(
      `
      insert into ${TDH_GRANTS_TABLE}
      (
       id,
       grantor_id,
       target_partition,
       target_chain,
       target_contract,
       token_mode,
       created_at,
       updated_at,
       valid_from,
       valid_to,
       tdh_rate,
       status,
       error_details,
       is_irrevocable,
       tokenset_id,
       replaced_grant_id
      ) values (
       :id,
       :grantor_id,
       :target_partition,
       :target_chain,
       :target_contract,
       :token_mode,
       :created_at,
       :updated_at,
       :valid_from,
       :valid_to,
       :tdh_rate,
       :status,
       :error_details,
       :is_irrevocable,
       :tokenset_id,
       :replaced_grant_id
      )
    `,
      tdhGrantEntity,
      {
        wrappedConnection: ctx.connection
      }
    );
    await bulkInsert(
      this.db,
      TDH_GRANT_TOKENS_TABLE,
      tokens as unknown as Record<string, any>[],
      ['tokenset_id', 'token_id', 'target_partition'],
      ctx
    );
    ctx.timer?.stop(`${this.constructor.name}->insertGrant`);
  }

  public async getPageItems(
    {
      grantor_id,
      target_contract,
      target_chain,
      status,
      sort_direction,
      sort,
      limit,
      offset
    }: {
      readonly grantor_id: string | null;
      readonly target_contract: string | null;
      readonly target_chain: number | null;
      readonly status: TdhGrantStatus[];
      readonly sort_direction: 'ASC' | 'DESC' | null;
      readonly sort:
        | 'created_at'
        | 'valid_from'
        | 'valid_to'
        | 'tdh_rate'
        | null;
      readonly limit: number;
      readonly offset: number;
    },
    ctx: RequestContext
  ): Promise<TdhGrantEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getPageItems`);
      const select = `SELECT t.* FROM ${TDH_GRANTS_TABLE} t`;
      const { whereAnds, params } = this.getSearchWhereAnds(
        grantor_id,
        target_contract,
        target_chain,
        status
      );
      const ordering = `order by t.${sort ?? 'created_at'} ${sort_direction ?? ''} limit :limit offset :offset`;
      params.limit = limit;
      params.offset = offset;
      const sql = `${select} ${whereAnds.length ? ` where ` : ``} ${whereAnds.join(' and ')} ${ordering}`;
      return await this.db.execute<TdhGrantEntity>(sql, params, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getPageItems`);
    }
  }

  public async countItems(
    {
      grantor_id,
      target_contract,
      target_chain,
      status
    }: {
      readonly grantor_id: string | null;
      readonly target_contract: string | null;
      readonly target_chain: number | null;
      readonly status: TdhGrantStatus[];
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countItems`);
      const select = `SELECT count(*) as cnt FROM ${TDH_GRANTS_TABLE} t`;
      const { whereAnds, params } = this.getSearchWhereAnds(
        grantor_id,
        target_contract,
        target_chain,
        status
      );
      const sql = `${select} ${whereAnds.length ? ` where ` : ``} ${whereAnds.join(' and ')}`;
      return await this.db
        .oneOrNull<{ cnt: number }>(sql, params, {
          wrappedConnection: ctx.connection
        })
        .then((it) => it?.cnt ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->countItems`);
    }
  }

  private getSearchWhereAnds(
    grantor_id: string | null,
    target_contract: string | null,
    target_chain: number | null,
    status: TdhGrantStatus[]
  ) {
    const whereAnds: string[] = [];
    const params: Record<string, any> = {};
    if (grantor_id) {
      whereAnds.push(`t.grantor_id = :grantor_id`);
      params['grantor_id'] = grantor_id;
    }
    if (target_contract) {
      whereAnds.push(`t.target_contract = :target_contract`);
      params['target_contract'] = target_contract;
    }
    if (target_chain) {
      whereAnds.push(`t.target_chain = :target_chain`);
      params['target_chain'] = target_chain;
    }
    if (status.length) {
      whereAnds.push(`t.status in (:status)`);
      params['status'] = status;
    }
    return { whereAnds, params };
  }

  async updateStatus(
    param: {
      grantId: string;
      status: TdhGrantStatus;
      error: string | null;
      validFrom?: number;
    },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->updateStatus`);
    this.logger.info(`Updating grant status`, param);
    try {
      await this.db.execute(
        `update ${TDH_GRANTS_TABLE}
         set status = :status,
             error_details = :error,
             updated_at = :now
             ${param.validFrom ? `, valid_from = :validFrom ` : ``}
         where id = :grantId`,
        { ...param, now: Time.currentMillis() },
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateStatus`);
    }
  }

  async getGrantorsMaxSpentTdhRateInTimeSpan(
    param: {
      grantorId: string;
      validFrom: number;
      validTo: number;
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantorsMaxSpentTdhRateInTimeSpan`
      );
      return this.db
        .oneOrNull<{ spent_rate: number }>(
          `
            WITH
              base AS (
                SELECT COALESCE(SUM(g.tdh_rate), 0) AS base_rate
                FROM ${TDH_GRANTS_TABLE} g
                WHERE g.grantor_id = :grantorId
                  AND g.status = '${TdhGrantStatus.GRANTED}'
                  AND g.valid_from <= :validFrom
                  AND (g.valid_to IS NULL OR g.valid_to > :validFrom)
              ),
              edges AS (
                -- +rate at starts strictly inside the window
                SELECT g.valid_from AS ts, g.tdh_rate AS delta
                FROM ${TDH_GRANTS_TABLE} g
                WHERE g.grantor_id = :grantorId
                  AND g.status = '${TdhGrantStatus.GRANTED}'
                  AND g.valid_from > :validFrom
                  AND g.valid_from < :validTo
                  AND (g.valid_to IS NULL OR g.valid_to > :validFrom)

                UNION ALL

                -- -rate at ends inside the window
                SELECT g.valid_to AS ts, -g.tdh_rate AS delta
                FROM ${TDH_GRANTS_TABLE} g
                WHERE g.grantor_id = :grantorId
                  AND g.status = '${TdhGrantStatus.GRANTED}'
                  AND g.valid_to IS NOT NULL
                  AND g.valid_to > :validFrom
                  AND g.valid_to <= :validTo
                  AND g.valid_from < :validTo
              ),
              agg AS (
                SELECT ts, SUM(delta) AS delta
                FROM edges
                GROUP BY ts
              ),
              scan AS (
                SELECT
                  ts,
                  (SELECT base_rate FROM base) + SUM(delta) OVER (ORDER BY ts) AS running_rate
                FROM agg
              )
            SELECT GREATEST(
                     (SELECT base_rate FROM base),
                     COALESCE((SELECT MAX(running_rate) FROM scan), 0)
                   ) AS spent_rate
        `,
          param,
          {
            wrappedConnection: ctx.connection
          }
        )
        ?.then((res) => +(res?.spent_rate ?? 0));
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantorsMaxSpentTdhRateInTimeSpan`
      );
    }
  }

  async getGrantorsLooseMaxRateToStillSpend(
    grantorId: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantorsLooseMaxRateToStillSpend`
      );
      return this.db
        .oneOrNull<{ spent_rate: number }>(
          `
            SELECT COALESCE(SUM(gts.xtdh_rate_daily), 0) AS total_granted_tdh_rate
            FROM xtdh_token_grant_stats_a gts
            JOIN tdh_grants g
              ON g.id = gts.grant_id
            WHERE g.grantor_id = :grantorId
        `,
          { grantorId },
          {
            wrappedConnection: ctx.connection
          }
        )
        ?.then((res) => +(res?.spent_rate ?? 0));
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantorsLooseMaxRateToStillSpend`
      );
    }
  }

  async getOverflowedGrantsWithGrantorRates(
    ctx: RequestContext
  ): Promise<GrantWithCap[]> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getOverflowedGrantsWithGrantorRates`
      );
      return await this.db
        .execute<GrantWithCap>(
          `
            WITH
              latest_boost AS (
                SELECT consolidation_key, boost
                FROM (
                       SELECT
                         consolidation_key,
                         boost,
                         ROW_NUMBER() OVER (PARTITION BY consolidation_key ORDER BY block DESC) AS rn
                       FROM ${CONSOLIDATED_WALLETS_TDH_TABLE}
                     ) x
                WHERE rn = 1
              ),

              capacity AS (
                SELECT
                  i.profile_id AS grantor_id,
                  COALESCE(SUM(ed.hodl_rate), 0)
                    * COALESCE(MAX(lb.boost), 1.0)
                    * ${X_TDH_COEFFICIENT}
                               AS grantor_x_tdh_rate
                FROM ${IDENTITIES_TABLE} i
                       LEFT JOIN ${CONSOLIDATED_TDH_EDITIONS_TABLE} ed
                                 ON ed.consolidation_key = i.consolidation_key
                       LEFT JOIN latest_boost lb
                                 ON lb.consolidation_key = i.consolidation_key
                WHERE i.profile_id IS NOT NULL
                GROUP BY i.profile_id
              ),

              gr AS (
                SELECT *
                FROM ${TDH_GRANTS_TABLE}
                WHERE status = '${TdhGrantStatus.GRANTED}'
                  AND valid_from < :windowEnd
                  AND (valid_to   IS NULL OR valid_to   > :windowStart)
              ),

              grantors_in_window AS (
                SELECT DISTINCT grantor_id FROM gr
              ),

              base AS (
                SELECT
                  grantor_id,
                  :windowStart AS ts,
                  COALESCE(SUM(tdh_rate), 0) AS delta
                FROM gr
                WHERE valid_from <= :windowStart
                  AND (valid_to   IS NULL OR valid_to   >  :windowStart)
                GROUP BY grantor_id
              ),

              edges AS (
                SELECT grantor_id, valid_from AS ts,  tdh_rate AS delta
                FROM gr
                WHERE valid_from IS NOT NULL
                  AND valid_from > :windowStart AND valid_from < :windowEnd
                UNION ALL
                SELECT grantor_id, valid_to   AS ts, -tdh_rate AS delta
                FROM gr
                WHERE valid_to IS NOT NULL
                  AND valid_to > :windowStart AND valid_to <= :windowEnd
              ),

              tail AS (
                SELECT giw.grantor_id, :windowEnd AS ts, 0 AS delta
                FROM grantors_in_window giw
              ),

              events AS (
                SELECT grantor_id, ts, SUM(delta) AS delta
                FROM (
                       SELECT * FROM base
                       UNION ALL SELECT * FROM edges
                       UNION ALL SELECT * FROM tail
                     ) e
                GROUP BY grantor_id, ts
              ),

              scan AS (
                SELECT
                  grantor_id,
                  ts,
                  SUM(delta) OVER (PARTITION BY grantor_id ORDER BY ts ROWS UNBOUNDED PRECEDING) AS active_rate
                FROM events
              ),

              intervals AS (
                SELECT
                  grantor_id,
                  ts AS interval_start,
                  LEAD(ts) OVER (PARTITION BY grantor_id ORDER BY ts) AS interval_end,
                  active_rate AS interval_active_rate
                FROM scan
              ),

              over_intervals AS (
                SELECT i.grantor_id, i.interval_start, i.interval_end
                FROM intervals i
                       JOIN capacity c ON c.grantor_id = i.grantor_id
                WHERE i.interval_end IS NOT NULL
                  AND i.interval_active_rate > c.grantor_x_tdh_rate
              )

            SELECT DISTINCT
              c.grantor_x_tdh_rate,
              g.*
            FROM over_intervals oi
                   JOIN gr g
                        ON g.grantor_id = oi.grantor_id
                          AND g.valid_from < oi.interval_end
                          AND (g.valid_to   IS NULL OR g.valid_to   > oi.interval_start)
                   JOIN capacity c
                        ON c.grantor_id = g.grantor_id
      `,
          {
            windowStart: 0,
            windowEnd: 99999999999999
          },
          {
            wrappedConnection: ctx.connection
          }
        )
        .then((results) =>
          results.map((it) => ({
            ...it,
            valid_from: numbers.parseIntOrThrow(it.valid_from),
            valid_to: numbers.parseIntOrNull(it.valid_to),
            grantor_x_tdh_rate: numbers.parseNumberOrThrow(
              it.grantor_x_tdh_rate
            )
          }))
        );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getOverflowedGrantsWithGrantorRates`
      );
    }
  }

  async bulkUpdateStatus(
    param: { ids: string[]; status: TdhGrantStatus; error: string | null },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->updateStatus`);
    try {
      if (param.ids.length) {
        await this.db.execute(
          `update ${TDH_GRANTS_TABLE}
         set status = :status,
             error_details = :error,
             updated_at = :now
         where id in (:ids)`,
          { ...param, now: Time.currentMillis() },
          {
            wrappedConnection: ctx.connection
          }
        );
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateStatus`);
    }
  }

  async bulkInsert(entities: TdhGrantEntity[], ctx: RequestContext) {
    await bulkInsert(
      this.db,
      TDH_GRANTS_TABLE,
      entities as unknown as Record<string, any>[],
      [
        'id',
        'tokenset_id',
        'replaced_grant_id',
        'grantor_id',
        'target_chain',
        'target_contract',
        'target_partition',
        'token_mode',
        'created_at',
        'updated_at',
        'valid_from',
        'valid_to',
        'tdh_rate',
        'status',
        'error_details',
        'is_irrevocable'
      ],
      ctx
    );
  }

  async getGrantsTokenCounts(
    grantIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantsTokenCounts`);
      if (!grantIds.length) {
        return {};
      }
      const dbResults = await this.db.execute<{
        grant_id: string;
        token_count: number;
      }>(
        `
              SELECT
                  g.id AS grant_id,
                  CASE
                      WHEN g.token_mode = 'ALL' THEN (
                          SELECT COUNT(DISTINCT h.token_id)
                          FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
                          WHERE h.\`partition\` = g.target_partition
                      )
                      WHEN g.token_mode = 'INCLUDE' THEN (
                          SELECT COUNT(DISTINCT t.token_id)
                          FROM ${TDH_GRANT_TOKENS_TABLE} t
                          WHERE t.tokenset_id      = g.tokenset_id
                            AND t.target_partition = g.target_partition
                            AND EXISTS (
                              SELECT 1
                              FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
                              WHERE h.\`partition\` = t.target_partition
                                AND h.token_id    = t.token_id
                          )
                      )
                      ELSE 0
                      END AS token_count
              FROM tdh_grants g
              WHERE g.id IN (:grantIds)
        `,
        { grantIds },
        { wrappedConnection: ctx.connection }
      );
      return dbResults.reduce(
        (acc, it) => {
          acc[it.grant_id] = it.token_count;
          return acc;
        },
        {} as Record<string, number>
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantsTokenCounts`);
    }
  }

  async getGrantTokensPage(
    param: {
      grant_id: string;
      sort_direction: PageSortDirection;
      sort: 'token';
      limit: number;
      offset: number;
    },
    ctx: RequestContext
  ): Promise<string[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantTokensPage`);

      const { grant_id, sort_direction, limit, offset } = param;
      const grant = await this.db.oneOrNull<{
        token_mode: TdhGrantTokenMode;
        target_partition: string;
        tokenset_id: string | null;
      }>(
        `
        SELECT token_mode, target_partition, tokenset_id
        FROM ${TDH_GRANTS_TABLE}
        WHERE id = :grant_id
      `,
        { grant_id },
        { wrappedConnection: ctx.connection }
      );

      if (!grant) {
        return [];
      }

      const direction = sort_direction === 'DESC' ? 'DESC' : 'ASC';

      let sql: string;
      const params: Record<string, unknown> = {
        limit,
        offset
      };

      if (grant.token_mode === TdhGrantTokenMode.ALL) {
        sql = `
        SELECT DISTINCT h.token_id AS token
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        WHERE h.\`partition\` = :partition
        ORDER BY h.token_id ${direction}
        LIMIT :limit OFFSET :offset
      `;
        params.partition = grant.target_partition;
      } else if (
        grant.token_mode === TdhGrantTokenMode.INCLUDE &&
        grant.tokenset_id
      ) {
        sql = `
        SELECT DISTINCT t.token_id AS token
        FROM ${TDH_GRANT_TOKENS_TABLE} t
        WHERE t.tokenset_id      = :tokenset_id
          AND t.target_partition = :partition
          AND EXISTS (
            SELECT 1
            FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
            WHERE h.\`partition\` = t.target_partition
              AND h.token_id      = t.token_id
          )
        ORDER BY t.token_id ${direction}
        LIMIT :limit OFFSET :offset
      `;
        params.tokenset_id = grant.tokenset_id;
        params.partition = grant.target_partition;
      } else {
        return [];
      }

      const rows = await this.db.execute<{ token: string | number }>(
        sql,
        params,
        { wrappedConnection: ctx.connection }
      );

      return rows.map((r) => String(r.token));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantTokensPage`);
    }
  }

  public async getGrantsByIds(
    grantIds: string[],
    ctx: RequestContext
  ): Promise<TdhGrantEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantsByIds`);
      if (!grantIds.length) {
        return [];
      }
      return this.db.execute<TdhGrantEntity>(
        `select * from ${TDH_GRANTS_TABLE} where id in (:grantIds)`,
        { grantIds },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantsByIds`);
    }
  }
}

export const tdhGrantsRepository = new TdhGrantsRepository(dbSupplier);
