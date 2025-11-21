import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../sql-executor';
import { RequestContext } from '../../../request.context';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_CONTRACTS_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  IDENTITIES_TABLE,
  TDH_GRANT_TOKENS_TABLE,
  TDH_GRANTS_TABLE,
  XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX,
  XTDH_TOKEN_STATS_TABLE_PREFIX
} from '../../../constants';
import { Time } from '../../../time';
import { TdhGrantStatus, TdhGrantTokenMode } from '../../../entities/ITdhGrant';

export class TdhStatsRepository extends LazyDbAccessCompatibleService {
  async getGrantedTdhCollectionsCount(
    id: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhCollectionsCount`
      );
      const lastUtcMidnightMillis = Time.latestUtcMidnight().toMillis();
      const sql = `
      WITH
      gr AS (
        SELECT g.id, g.grantor_id, g.target_partition, g.token_mode,
               g.tdh_rate, g.valid_from, g.valid_to, g.tokenset_id
        FROM ${TDH_GRANTS_TABLE} g
        WHERE g.status = '${TdhGrantStatus.GRANTED}'
          AND g.tdh_rate > 0
          AND g.grantor_id = :profile_id
          AND g.valid_from < :lastUtcMidnightMillis
      ),
      inc_counts AS (
        SELECT t.tokenset_id, COUNT(*) AS inc_cnt
        FROM ${TDH_GRANT_TOKENS_TABLE} t
        GROUP BY t.tokenset_id
      ),
      grant_divisor AS (
        SELECT gr.id, gr.target_partition,
               CASE
                 WHEN gr.token_mode = '${TdhGrantTokenMode.ALL}' THEN COALESCE(c.total_supply, 0)
                 ELSE COALESCE(ic.inc_cnt, 0)
               END AS denom
        FROM gr
        LEFT JOIN ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c ON c.\`partition\` = gr.target_partition
        LEFT JOIN inc_counts ic ON ic.tokenset_id = gr.tokenset_id
      ),
      grant_tokens AS (
        SELECT gr.id AS grant_id, gr.target_partition AS \`partition\`, h.token_id
        FROM gr
        JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h ON h.\`partition\` = gr.target_partition
        WHERE gr.token_mode = '${TdhGrantTokenMode.ALL}'
        GROUP BY gr.id, gr.target_partition, h.token_id
        UNION ALL
        SELECT gr.id AS grant_id, gr.target_partition AS \`partition\`, t.token_id
        FROM gr
        JOIN ${TDH_GRANT_TOKENS_TABLE} t
          ON t.tokenset_id = gr.tokenset_id AND t.target_partition = gr.target_partition
        WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
      ),
      owners_at_cut AS (
        SELECT h.\`partition\`, h.token_id, h.owner,
               ROW_NUMBER() OVER (
                 PARTITION BY h.\`partition\`, h.token_id
                 ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
               ) AS rn
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        JOIN grant_tokens gt ON gt.\`partition\` = h.\`partition\` AND gt.token_id = h.token_id
        WHERE h.since_time < :lastUtcMidnightMillis
      ),
      hist_pre_cut AS (
        SELECT h.\`partition\`, h.token_id, h.owner AS new_owner, h.since_time,
               h.block_number, h.log_index, h.acquired_as_sale,
               LAG(h.owner) OVER (PARTITION BY h.\`partition\`, h.token_id
                                  ORDER BY h.since_time, h.block_number, h.log_index) AS prev_owner
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        WHERE h.since_time <= :lastUtcMidnightMillis
      ),
      ck_map AS (
        SELECT ack.address AS addr, ack.consolidation_key AS ck
        FROM ${ADDRESS_CONSOLIDATION_KEY} ack
      ),
      hist_with_ck AS (
        SELECT hp.\`partition\`, hp.token_id, hp.new_owner,
               cm_new.ck AS new_ck, hp.prev_owner, cm_prev.ck AS prev_ck,
               hp.acquired_as_sale, hp.since_time
        FROM hist_pre_cut hp
        LEFT JOIN ck_map cm_new  ON cm_new.addr  = hp.new_owner
        LEFT JOIN ck_map cm_prev ON cm_prev.addr = hp.prev_owner
      ),
      last_reset AS (
        SELECT o.\`partition\`, o.token_id, MAX(h.since_time) AS reset_since_time
        FROM owners_at_cut o
        JOIN hist_with_ck h
          ON h.\`partition\` = o.\`partition\`
         AND h.token_id = o.token_id
         AND h.new_owner = o.owner
         AND (h.acquired_as_sale = 1 OR h.prev_ck IS NULL OR h.prev_ck <> h.new_ck)
        WHERE o.rn = 1
        GROUP BY o.\`partition\`, o.token_id
      ),
      bounded_windows AS (
        SELECT gt.grant_id, gt.\`partition\`, gt.token_id,
               GREATEST(COALESCE(lr.reset_since_time, g.valid_from), g.valid_from) AS start_ms,
               LEAST(:lastUtcMidnightMillis, COALESCE(g.valid_to, :lastUtcMidnightMillis)) AS end_ms,
               g.tdh_rate, gd.denom
        FROM grant_tokens gt
        JOIN gr g ON g.id = gt.grant_id
        JOIN grant_divisor gd ON gd.id = g.id
        LEFT JOIN last_reset lr ON lr.\`partition\` = gt.\`partition\` AND lr.token_id = gt.token_id
      ),
      days_owned AS (
        SELECT bw.grant_id, bw.\`partition\`, bw.token_id, bw.tdh_rate, bw.denom,
               GREATEST(0, DATEDIFF(
                 DATE(FROM_UNIXTIME(bw.end_ms / 1000)),
                 DATE(FROM_UNIXTIME(bw.start_ms / 1000))
               ) - 1) AS full_days,
               TIMESTAMPDIFF(DAY, FROM_UNIXTIME(bw.start_ms / 1000), FROM_UNIXTIME(:lastUtcMidnightMillis / 1000)) AS days_since_start
        FROM bounded_windows bw
        WHERE bw.end_ms > bw.start_ms
      ),
      contributors AS (
        SELECT d.\`partition\`
        FROM days_owned d
        WHERE d.tdh_rate > 0
          AND d.denom > 0
          AND d.full_days > 0
          AND d.days_since_start >= 2
      )
      SELECT COUNT(DISTINCT \`partition\`) AS collections_count FROM contributors;
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
    id: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantedTdhTokensCount`);
      const lastUtcMidnightMillis = Time.latestUtcMidnight().toMillis();

      const sql = `
      WITH
      gr AS (
        SELECT g.id, g.grantor_id, g.target_partition, g.token_mode,
               g.tdh_rate, g.valid_from, g.valid_to, g.tokenset_id
        FROM ${TDH_GRANTS_TABLE} g
        WHERE g.status = '${TdhGrantStatus.GRANTED}'
          AND g.tdh_rate > 0
          AND g.grantor_id = :profile_id
          AND g.valid_from < :lastUtcMidnightMillis
      ),
      inc_counts AS (
        SELECT t.tokenset_id, COUNT(*) AS inc_cnt
        FROM ${TDH_GRANT_TOKENS_TABLE} t
        GROUP BY t.tokenset_id
      ),
      grant_divisor AS (
        SELECT gr.id, gr.target_partition,
               CASE
                 WHEN gr.token_mode = '${TdhGrantTokenMode.ALL}' THEN COALESCE(c.total_supply, 0)
                 ELSE COALESCE(ic.inc_cnt, 0)
               END AS denom
        FROM gr
        LEFT JOIN ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c ON c.\`partition\` = gr.target_partition
        LEFT JOIN inc_counts ic ON ic.tokenset_id = gr.tokenset_id
      ),
      grant_tokens AS (
        SELECT gr.id AS grant_id, gr.target_partition AS \`partition\`, h.token_id
        FROM gr
        JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h ON h.\`partition\` = gr.target_partition
        WHERE gr.token_mode = '${TdhGrantTokenMode.ALL}'
        GROUP BY gr.id, gr.target_partition, h.token_id
        UNION ALL
        SELECT gr.id AS grant_id, gr.target_partition AS \`partition\`, t.token_id
        FROM gr
        JOIN ${TDH_GRANT_TOKENS_TABLE} t
          ON t.tokenset_id = gr.tokenset_id AND t.target_partition = gr.target_partition
        WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
      ),
      owners_at_cut AS (
        SELECT h.\`partition\`, h.token_id, h.owner,
               ROW_NUMBER() OVER (
                 PARTITION BY h.\`partition\`, h.token_id
                 ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
               ) AS rn
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        JOIN grant_tokens gt ON gt.\`partition\` = h.\`partition\` AND gt.token_id = h.token_id
        WHERE h.since_time < :lastUtcMidnightMillis
      ),
      hist_pre_cut AS (
        SELECT h.\`partition\`, h.token_id, h.owner AS new_owner, h.since_time,
               h.block_number, h.log_index, h.acquired_as_sale,
               LAG(h.owner) OVER (PARTITION BY h.\`partition\`, h.token_id
                                  ORDER BY h.since_time, h.block_number, h.log_index) AS prev_owner
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        WHERE h.since_time <= :lastUtcMidnightMillis
      ),
      ck_map AS (
        SELECT ack.address AS addr, ack.consolidation_key AS ck
        FROM ${ADDRESS_CONSOLIDATION_KEY} ack
      ),
      hist_with_ck AS (
        SELECT hp.\`partition\`, hp.token_id, hp.new_owner,
               cm_new.ck AS new_ck, hp.prev_owner, cm_prev.ck AS prev_ck,
               hp.acquired_as_sale, hp.since_time
        FROM hist_pre_cut hp
        LEFT JOIN ck_map cm_new  ON cm_new.addr  = hp.new_owner
        LEFT JOIN ck_map cm_prev ON cm_prev.addr = hp.prev_owner
      ),
      last_reset AS (
        SELECT o.\`partition\`, o.token_id, MAX(h.since_time) AS reset_since_time
        FROM owners_at_cut o
        JOIN hist_with_ck h
          ON h.\`partition\` = o.\`partition\`
         AND h.token_id = o.token_id
         AND h.new_owner = o.owner
         AND (h.acquired_as_sale = 1 OR h.prev_ck IS NULL OR h.prev_ck <> h.new_ck)
        WHERE o.rn = 1
        GROUP BY o.\`partition\`, o.token_id
      ),
      bounded_windows AS (
        SELECT gt.grant_id, gt.\`partition\`, gt.token_id,
               GREATEST(COALESCE(lr.reset_since_time, g.valid_from), g.valid_from) AS start_ms,
               LEAST(:lastUtcMidnightMillis, COALESCE(g.valid_to, :lastUtcMidnightMillis)) AS end_ms,
               g.tdh_rate, gd.denom
        FROM grant_tokens gt
        JOIN gr g ON g.id = gt.grant_id
        JOIN grant_divisor gd ON gd.id = g.id
        LEFT JOIN last_reset lr ON lr.\`partition\` = gt.\`partition\` AND lr.token_id = gt.token_id
      ),
      days_owned AS (
        SELECT bw.grant_id, bw.\`partition\`, bw.token_id, bw.tdh_rate, bw.denom,
               GREATEST(0, DATEDIFF(
                 DATE(FROM_UNIXTIME(bw.end_ms / 1000)),
                 DATE(FROM_UNIXTIME(bw.start_ms / 1000))
               ) - 1) AS full_days,
               TIMESTAMPDIFF(DAY, FROM_UNIXTIME(bw.start_ms / 1000), FROM_UNIXTIME(:lastUtcMidnightMillis / 1000)) AS days_since_start
        FROM bounded_windows bw
        WHERE bw.end_ms > bw.start_ms
      ),
      contributors AS (
        SELECT d.\`partition\`, d.token_id
        FROM days_owned d
        WHERE d.tdh_rate > 0
          AND d.denom > 0
          AND d.full_days > 0
          AND d.days_since_start >= 2
      )
      SELECT COUNT(DISTINCT CONCAT(d.\`partition\`, ':', d.token_id)) AS tokens_count
      FROM contributors d;
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
    id: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantedTdhTotalSum`);
      const lastUtcMidnightMillis = Time.latestUtcMidnight().toMillis();

      const sql = `
      WITH
      gr AS (
        SELECT g.id, g.grantor_id, g.target_partition, g.token_mode,
               g.tdh_rate, g.valid_from, g.valid_to, g.tokenset_id
        FROM ${TDH_GRANTS_TABLE} g
        WHERE g.status = '${TdhGrantStatus.GRANTED}'
          AND g.tdh_rate > 0
          AND g.grantor_id = :profile_id
          AND g.valid_from < :lastUtcMidnightMillis
      ),
      inc_counts AS (
        SELECT t.tokenset_id, COUNT(*) AS inc_cnt
        FROM ${TDH_GRANT_TOKENS_TABLE} t
        GROUP BY t.tokenset_id
      ),
      grant_divisor AS (
        SELECT gr.id, gr.target_partition,
               CASE
                 WHEN gr.token_mode = '${TdhGrantTokenMode.ALL}' THEN COALESCE(c.total_supply, 0)
                 ELSE COALESCE(ic.inc_cnt, 0)
               END AS denom
        FROM gr
        LEFT JOIN ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c ON c.\`partition\` = gr.target_partition
        LEFT JOIN inc_counts ic ON ic.tokenset_id = gr.tokenset_id
      ),
      grant_tokens AS (
        SELECT gr.id AS grant_id, gr.target_partition AS \`partition\`, h.token_id
        FROM gr
        JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h ON h.\`partition\` = gr.target_partition
        WHERE gr.token_mode = '${TdhGrantTokenMode.ALL}'
        GROUP BY gr.id, gr.target_partition, h.token_id
        UNION ALL
        SELECT gr.id AS grant_id, gr.target_partition AS \`partition\`, t.token_id
        FROM gr
        JOIN ${TDH_GRANT_TOKENS_TABLE} t
          ON t.tokenset_id = gr.tokenset_id AND t.target_partition = gr.target_partition
        WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
      ),
      owners_at_cut AS (
        SELECT h.\`partition\`, h.token_id, h.owner,
               ROW_NUMBER() OVER (
                 PARTITION BY h.\`partition\`, h.token_id
                 ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
               ) AS rn
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        JOIN grant_tokens gt ON gt.\`partition\` = h.\`partition\` AND gt.token_id = h.token_id
        WHERE h.since_time < :lastUtcMidnightMillis
      ),
      hist_pre_cut AS (
        SELECT h.\`partition\`, h.token_id, h.owner AS new_owner, h.since_time,
               h.block_number, h.log_index, h.acquired_as_sale,
               LAG(h.owner) OVER (PARTITION BY h.\`partition\`, h.token_id
                                  ORDER BY h.since_time, h.block_number, h.log_index) AS prev_owner
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        WHERE h.since_time <= :lastUtcMidnightMillis
      ),
      ck_map AS (
        SELECT ack.address AS addr, ack.consolidation_key AS ck
        FROM ${ADDRESS_CONSOLIDATION_KEY} ack
      ),
      hist_with_ck AS (
        SELECT hp.\`partition\`, hp.token_id, hp.new_owner,
               cm_new.ck AS new_ck, hp.prev_owner, cm_prev.ck AS prev_ck,
               hp.acquired_as_sale, hp.since_time
        FROM hist_pre_cut hp
        LEFT JOIN ck_map cm_new  ON cm_new.addr  = hp.new_owner
        LEFT JOIN ck_map cm_prev ON cm_prev.addr = hp.prev_owner
      ),
      last_reset AS (
        SELECT o.\`partition\`, o.token_id, MAX(h.since_time) AS reset_since_time
        FROM owners_at_cut o
        JOIN hist_with_ck h
          ON h.\`partition\` = o.\`partition\`
         AND h.token_id = o.token_id
         AND h.new_owner = o.owner
         AND (h.acquired_as_sale = 1 OR h.prev_ck IS NULL OR h.prev_ck <> h.new_ck)
        WHERE o.rn = 1
        GROUP BY o.\`partition\`, o.token_id
      ),
      bounded_windows AS (
        SELECT gt.grant_id, gt.\`partition\`, gt.token_id,
               GREATEST(COALESCE(lr.reset_since_time, g.valid_from), g.valid_from) AS start_ms,
               LEAST(:lastUtcMidnightMillis, COALESCE(g.valid_to, :lastUtcMidnightMillis)) AS end_ms,
               g.tdh_rate, gd.denom
        FROM grant_tokens gt
        JOIN gr g ON g.id = gt.grant_id
        JOIN grant_divisor gd ON gd.id = g.id
        LEFT JOIN last_reset lr ON lr.\`partition\` = gt.\`partition\` AND lr.token_id = gt.token_id
      ),
      days_owned AS (
        SELECT bw.grant_id, bw.\`partition\`, bw.token_id, bw.tdh_rate, bw.denom,
               GREATEST(0, DATEDIFF(
                 DATE(FROM_UNIXTIME(bw.end_ms / 1000)),
                 DATE(FROM_UNIXTIME(bw.start_ms / 1000))
               ) - 1) AS full_days,
               TIMESTAMPDIFF(DAY, FROM_UNIXTIME(bw.start_ms / 1000), FROM_UNIXTIME(:lastUtcMidnightMillis / 1000)) AS days_since_start
        FROM bounded_windows bw
        WHERE bw.end_ms > bw.start_ms
      ),
      contributions AS (
        SELECT
          d.\`partition\`,
          d.token_id,
          CASE WHEN d.denom > 0 THEN (d.tdh_rate / d.denom) ELSE 0 END AS contribution_for_last_midnight
        FROM days_owned d
        WHERE d.tdh_rate > 0
          AND d.denom > 0
          AND d.full_days > 0
          AND d.days_since_start >= 2
      )
      SELECT COALESCE(SUM(contribution_for_last_midnight), 0) AS total_granted_tdh_for_last_midnight
      FROM contributions;
    `;
      const res = await this.db.oneOrNull<{
        total_granted_tdh_for_last_midnight: number;
      }>(
        sql,
        { profile_id: id, lastUtcMidnightMillis },
        { wrappedConnection: ctx.connection }
      );

      return res?.total_granted_tdh_for_last_midnight ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantedTdhTotalSum`);
    }
  }

  async getIncomingXTdhRate(
    { identityId, slot }: { identityId: string; slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getBaseTdh`);
      const GRANT_TABLE = `${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot}`;
      const TOKEN_STATA_TABLE = `${XTDH_TOKEN_STATS_TABLE_PREFIX}${slot}`;
      return await this.db
        .oneOrNull<{ boosted_tdh: number }>(
          `
          SELECT
              SUM(gts.xtdh_rate_daily) AS received_rate
          FROM ${GRANT_TABLE} gts
                   JOIN ${TDH_GRANTS_TABLE} g
                        ON g.id = gts.grant_id
                   JOIN ${TOKEN_STATA_TABLE} ts
                        ON ts.partition = gts.partition
                            AND ts.token_id = gts.token_id
                   JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
                        ON ack.address = ts.owner
                   JOIN ${IDENTITIES_TABLE} i
                        ON i.consolidation_key = ack.consolidation_key
          WHERE i.profile_id = :identityId
            AND g.grantor_id != i.profile_id
      `,
          { identityId },
          { wrappedConnection: ctx.connection }
        )
        .then((it) => it?.boosted_tdh ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getBaseTdh`);
    }
  }
}

export const tdhStatsRepository = new TdhStatsRepository(dbSupplier);
