import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RequestContext } from '../../../request.context';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  TDH_GRANTS_TABLE,
  XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX,
  XTDH_TOKEN_STATS_TABLE_PREFIX
} from '../../../constants';
import { Time } from '../../../time';

export class TdhStatsRepository extends LazyDbAccessCompatibleService {
  async getGrantedTdhCollectionsGlobalCount(
    { slot }: { slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhCollectionsGlobalCount`
      );
      const sql = `SELECT COUNT(DISTINCT s.partition) AS collections_count
        FROM ${XTDH_TOKEN_STATS_TABLE_PREFIX}${slot} s
        WHERE s.xtdh_total > 0`;
      const res = await this.db.oneOrNull<{ collections_count: number }>(
        sql,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      return res?.collections_count ?? 0;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantedTdhCollectionsGlobalCount`
      );
    }
  }

  async getGrantedTdhTokensGlobalCount(
    { slot }: { slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhTokensGlobalCount`
      );
      const sql = `SELECT COUNT(*) as cnt FROM ${XTDH_TOKEN_STATS_TABLE_PREFIX}${slot} where xtdh_total > 0`;
      const res = await this.db.oneOrNull<{ cnt: number }>(sql, undefined, {
        wrappedConnection: ctx.connection
      });
      return res?.cnt ?? 0;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantedTdhTokensGlobalCount`
      );
    }
  }

  async getGrantedTdhTotalSumPerDayGlobal(
    { slot }: { slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhTotalSumPerDayGlobal`
      );

      const sql = `
      SELECT COALESCE(SUM(gts.xtdh_rate_daily), 0) AS total_granted_tdh_per_day
      FROM ${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot} gts
    `;

      const res = await this.db.oneOrNull<{
        total_granted_tdh_per_day: number;
      }>(sql, undefined, { wrappedConnection: ctx.connection });

      return res?.total_granted_tdh_per_day ?? 0;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantedTdhTotalSumPerDayGlobal`
      );
    }
  }

  async getGrantedTdhCollectionsCount(
    { id, slot }: { id: string; slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhCollectionsCount`
      );
      const lastUtcMidnightMillis = Time.latestUtcMidnight().toMillis();
      const sql = `
      SELECT COUNT(DISTINCT gts.partition) AS collections_count
      FROM ${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot} gts
      JOIN tdh_grants g
        ON g.id = gts.grant_id
      WHERE g.grantor_id = :profile_id
        AND gts.xtdh_rate_daily > 0
    `;
      const res = await this.db.oneOrNull<{ collections_count: number }>(
        sql,
        { profile_id: id, lastUtcMidnightMillis },
        { wrappedConnection: ctx.connection }
      );
      return res?.collections_count ?? 0;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getGrantedTdhCollectionsCount`
      );
    }
  }

  async getGrantedTdhTokensCount(
    { id, slot }: { id: string; slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantedTdhTokensCount`);
      const lastUtcMidnightMillis = Time.latestUtcMidnight().toMillis();
      const sql = `
      SELECT COUNT(DISTINCT CONCAT(gts.partition, ':', gts.token_id)) AS tokens_count
      FROM ${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot} gts
      JOIN ${TDH_GRANTS_TABLE} g ON g.id = gts.grant_id
      WHERE g.grantor_id = :profile_id
        AND gts.xtdh_rate_daily > 0
      `;

      const res = await this.db.oneOrNull<{ tokens_count: number }>(
        sql,
        { profile_id: id, lastUtcMidnightMillis },
        { wrappedConnection: ctx.connection }
      );

      return res?.tokens_count ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantedTdhTokensCount`);
    }
  }

  async getGrantedTdhTotalSumPerDay(
    { id, slot }: { id: string; slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantedTdhTotalSum`);
      const sql = `
      SELECT COALESCE(SUM(gts.xtdh_rate_daily), 0) AS total_granted_tdh_rate
      FROM ${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot} gts
      JOIN ${TDH_GRANTS_TABLE} g
        ON g.id = gts.grant_id
      WHERE g.grantor_id = :profile_id
    `;
      const res = await this.db.oneOrNull<{
        total_granted_tdh_rate: number;
      }>(sql, { profile_id: id }, { wrappedConnection: ctx.connection });

      return res?.total_granted_tdh_rate ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantedTdhTotalSum`);
    }
  }

  async getIncomingXTdhRate(
    { identityId, slot }: { identityId: string; slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getIncomingXTdhRate`);
      const GRANT_TABLE = `${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot}`;
      const TOKEN_STATS_TABLE = `${XTDH_TOKEN_STATS_TABLE_PREFIX}${slot}`;
      return await this.db
        .oneOrNull<{ received_rate: number }>(
          `
          SELECT
              SUM(gts.xtdh_rate_daily) AS received_rate
          FROM ${GRANT_TABLE} gts
                   JOIN ${TDH_GRANTS_TABLE} g
                        ON g.id = gts.grant_id
                   JOIN ${TOKEN_STATS_TABLE} ts
                        ON ts.partition = gts.partition
                            AND ts.token_id = gts.token_id
                   JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
                        ON ack.address = ts.owner
                   JOIN ${IDENTITIES_TABLE} i
                        ON i.consolidation_key = ack.consolidation_key
          WHERE i.profile_id = :identityId
      `,
          { identityId },
          { wrappedConnection: ctx.connection }
        )
        .then((it) => it?.received_rate ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getIncomingXTdhRate`);
    }
  }

  async getGlobalIdentityStats(ctx: RequestContext): Promise<{
    tdh: number;
    tdh_rate: number;
    xtdh: number;
    xtdh_rate: number;
  }> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGlobalIdentityStats`);
      return this.db
        .oneOrNull<{
          tdh: number;
          tdh_rate: number;
          xtdh: number;
          xtdh_rate: number;
        }>(
          `select sum(tdh) as tdh, sum(basetdh_rate) as tdh_rate, sum(xtdh) as xtdh, sum(xtdh_rate) as xtdh_rate from ${IDENTITIES_TABLE}`
        )
        .then((it) => it ?? { tdh: 0, tdh_rate: 0, xtdh: 0, xtdh_rate: 0 });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGlobalIdentityStats`);
    }
  }

  async getGrantedXTdhRateGlobal(
    { slot }: { slot: 'a' | 'b' },
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getXTdhGrantedLastMidnightGlobal`
      );

      const res = await this.db.oneOrNull<{
        total_xtdh_granted_last_midnight: number;
      }>(
        `
          SELECT
            COALESCE(SUM(gts.xtdh_rate_daily), 0) AS total_xtdh_granted_last_midnight
          FROM ${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot} gts
        `,
        undefined,
        {
          wrappedConnection: ctx.connection
        }
      );

      return res?.total_xtdh_granted_last_midnight ?? 0;
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getXTdhGrantedLastMidnightGlobal`
      );
    }
  }
}

export const tdhStatsRepository = new TdhStatsRepository(dbSupplier);
