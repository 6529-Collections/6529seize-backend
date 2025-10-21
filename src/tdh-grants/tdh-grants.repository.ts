import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import {
  TdhGrantEntity,
  TdhGrantStatus,
  TdhGrantTokenMode
} from '../entities/ITdhGrant';
import { RequestContext } from '../request.context';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITIES_TABLE,
  TDH_EDITIONS_TABLE,
  TDH_GRANT_TOKENS_TABLE,
  TDH_GRANTS_TABLE
} from '../constants';
import { Time } from '../time';
import { Logger } from '../logging';
import { TdhGrantTokenEntity } from '../entities/ITdhGrantToken';
import { bulkInsert } from '../db/my-sql.helpers';
import { numbers } from '../numbers';
import { randomUUID } from 'node:crypto';

export type TdhGrantOverflowRow = {
  grant_id: string;
  grantor_id: string;
  valid_from: number | null;
  valid_to: number | null;
  grant_tdh_rate: number;
  grantors_tdh_rate: number;
  seg_valid_from: number;
  seg_valid_to: number | null;
};

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
      if (grant.token_mode === TdhGrantTokenMode.INCLUDE) {
        await this.db
          .execute<{
            token_id: string;
          }>(
            `select token_id from ${TDH_GRANT_TOKENS_TABLE} where grant_id = :grant_id`,
            { grant_id: grant.id },
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
       target_tokens,
       token_mode,
       created_at,
       updated_at,
       valid_from,
       valid_to,
       tdh_rate,
       status,
       error_details,
       is_irrevocable
      ) values (
       :id,
       :grantor_id,
       :target_partition,
       :target_chain,
       :target_contract,
       :target_tokens,
       :token_mode,
       :created_at,
       :updated_at,
       :valid_from,
       :valid_to,
       :tdh_rate,
       :status,
       :error_details,
       :is_irrevocable         
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
      ['grant_id', 'token_id', 'target_partition'],
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
      readonly status: TdhGrantStatus | null;
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
      readonly status: TdhGrantStatus | null;
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
    status:
      | TdhGrantStatus
      | null
      | TdhGrantStatus.PENDING
      | TdhGrantStatus.FAILED
      | TdhGrantStatus.GRANTED
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
    if (status) {
      whereAnds.push(`t.status = :status`);
      params['status'] = status;
    }
    return { whereAnds, params };
  }

  async updateStatus(
    param: { grantId: string; status: TdhGrantStatus; error: string | null },
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

  async getGrantorsSpentTdhRateInTimeSpan(
    param: {
      grantorId: string;
      validFrom: number;
      validTo: number | null;
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantorsActiveGrantsInTimeSpan`
      );
      return this.db
        .oneOrNull<{ spent_rate: number }>(
          `
        select sum(g.tdh_rate) as spent_rate from ${TDH_GRANTS_TABLE} g 
        where g.grantor_id = :grantorId
        and g.status = '${TdhGrantStatus.GRANTED}'
        and g.valid_from >= :validFrom
        and (g.valid_to is null ${param.validTo === null ? `` : ` or g.valid_to <= :validTo`})
        `,
          param,
          {
            wrappedConnection: ctx.connection
          }
        )
        ?.then((res) => +(res?.spent_rate ?? 0));
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantorsActiveGrantsInTimeSpan`
      );
    }
  }

  async getOverflowedGrantsWithGrantorRates(
    ctx: RequestContext
  ): Promise<TdhGrantOverflowRow[]> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantorsWithOverflowedGrants`
      );
      return await this.db
        .execute<TdhGrantOverflowRow>(
          `
        WITH granted_grants AS (
            SELECT *
            FROM ${TDH_GRANTS_TABLE}
            WHERE status = 'GRANTED'
        ),
             events AS (
                 SELECT grantor_id, valid_from AS ts,  tdh_rate AS delta
                 FROM granted_grants
                 UNION ALL
                 SELECT grantor_id, valid_to + 1 AS ts, -tdh_rate AS delta
                 FROM granted_grants
                 WHERE valid_to IS NOT NULL
             ),
             collapsed AS (
                 SELECT grantor_id, ts, SUM(delta) AS net_delta
                 FROM events
                 GROUP BY grantor_id, ts
                 HAVING SUM(delta) <> 0
             ),
             running AS (
                 SELECT
                     grantor_id,
                     ts,
                     SUM(net_delta) OVER (
                         PARTITION BY grantor_id
                         ORDER BY ts
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                         ) AS tdh_rate_sum,
                     LEAD(ts) OVER (PARTITION BY grantor_id ORDER BY ts) AS next_ts
                 FROM collapsed
             ),
             segments AS (
                 SELECT
                     grantor_id,
                     ts AS valid_from,
                     CASE WHEN next_ts IS NULL THEN NULL ELSE next_ts - 1 END AS valid_to,
                     tdh_rate_sum AS tdh_rate
                 FROM running
                 WHERE tdh_rate_sum > 0
             ),
             x_tdh_rates AS (
                 select i.profile_id as grantor_id, sum(ifnull(e.hodl_rate,0)) * t.boost * 0.1 AS x_tdh_rate
                 from
                   ${IDENTITIES_TABLE} i
                     join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on i.consolidation_key = t.consolidation_key
                     join ${ADDRESS_CONSOLIDATION_KEY} ac on ac.consolidation_key = t.consolidation_key
                     left join ${TDH_EDITIONS_TABLE} e on e.wallet = ac.address
                 group by i.profile_id, t.boost
             ),
             overflow_segments AS (
                 SELECT s.*
                 FROM segments s
                          LEFT JOIN x_tdh_rates x
                               ON x.grantor_id = s.grantor_id
                 WHERE s.tdh_rate > ifnull(x.x_tdh_rate, 0)
             )
        SELECT DISTINCT
            g.id            AS grant_id,
            g.grantor_id    AS grantor_id,
            g.valid_from    AS valid_from,
            g.valid_to      AS valid_to,
            g.tdh_rate      AS grant_tdh_rate,
            x.x_tdh_rate    AS grantors_tdh_rate,
            s.valid_from    AS seg_valid_from,
            s.valid_to      AS seg_valid_to
        FROM overflow_segments s
                 JOIN granted_grants g
                      ON g.grantor_id = s.grantor_id
                          AND (s.valid_to IS NULL OR g.valid_from <= s.valid_to)
                          AND (g.valid_to IS NULL OR g.valid_to >= s.valid_from)
                 JOIN x_tdh_rates x
                      ON x.grantor_id = s.grantor_id
        ORDER BY grantor_id, valid_from, grant_id
      `,
          undefined,
          {
            wrappedConnection: ctx.connection
          }
        )
        .then((results) =>
          results.map((it) => ({
            ...it,
            valid_from: numbers.parseIntOrThrow(it.valid_from),
            valid_to: numbers.parseIntOrNull(it.valid_to),
            grant_tdh_rate: numbers.parseNumberOrThrow(it.grant_tdh_rate),
            grantors_tdh_rate: numbers.parseNumberOrThrow(it.grantors_tdh_rate),
            seg_valid_from: numbers.parseIntOrThrow(it.seg_valid_from),
            seg_valid_to: numbers.parseIntOrNull(it.seg_valid_to)
          }))
        );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantorsWithOverflowedGrants`
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

  async insertReplacementGrants(
    param: { grant_id: string; new_rate: number }[],
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertReplacementGrants`);
    try {
      if (!param.length) return;

      const now = Time.currentMillis();
      const binds: Record<string, unknown> = { now };

      const rowsSql: string[] = param.map((p, i) => {
        const gid = `old_grant_id_${i}`;
        const rate = `new_rate_${i}`;
        const nid = `new_id_${i}`;

        binds[gid] = p.grant_id;
        binds[rate] = p.new_rate;
        binds[nid] = randomUUID();

        return `SELECT :${gid} AS old_grant_id, :${rate} AS new_rate, :${nid} AS new_id`;
      });

      // This is a SELECT ... UNION ALL SELECT ... used as a derived table
      const mappingDerived = rowsSql.join(` UNION ALL `);

      // 1) Insert replacement grants (clone + overrides) — NO CTE here
      const insertGrantsSql = `
        INSERT INTO ${TDH_GRANTS_TABLE} (
          id,
          grantor_id,
          target_chain,
          target_contract,
          target_tokens,
          created_at,
          valid_from,
          valid_to,
          tdh_rate,
          status,
          error_details,
          is_irrevocable,
          target_partition,
          updated_at,
          token_mode
        )
        SELECT
          m.new_id,
          g.grantor_id,
          g.target_chain,
          g.target_contract,
          g.target_tokens,
          :now,
          g.valid_from,
          g.valid_to,
          m.new_rate,
          '${TdhGrantStatus.GRANTED}',
          NULL,
          g.is_irrevocable,
          g.target_partition,
          :now,
          g.token_mode
        FROM (${mappingDerived}) AS m
               JOIN ${TDH_GRANTS_TABLE} g
                    ON g.id = m.old_grant_id;
      `;
      await this.db.execute(insertGrantsSql, binds, {
        wrappedConnection: ctx.connection
      });

      // 2) Delete dupes that would collide after we repoint tokens
      const deleteDupesSql = `
      DELETE tgt
      FROM ${TDH_GRANT_TOKENS_TABLE} tgt
      JOIN (${mappingDerived}) AS m
        ON tgt.grant_id = m.old_grant_id
      JOIN ${TDH_GRANT_TOKENS_TABLE} dupe
        ON dupe.grant_id = m.new_id
       AND dupe.token_id = tgt.token_id
       AND dupe.target_partition = tgt.target_partition;
    `;
      await this.db.execute(deleteDupesSql, binds, {
        wrappedConnection: ctx.connection
      });

      // 3) Repoint token rows old -> new grant_id
      const updateTokensSql = `
        UPDATE ${TDH_GRANT_TOKENS_TABLE} tgt
          JOIN (${mappingDerived}) AS m
          ON tgt.grant_id = m.old_grant_id
        SET tgt.grant_id = m.new_id;
      `;
      await this.db.execute(updateTokensSql, binds, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->insertReplacementGrants`);
    }
  }
}

export const tdhGrantsRepository = new TdhGrantsRepository(dbSupplier);
