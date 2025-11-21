import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { RequestContext } from '../request.context';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  EXTERNAL_INDEXED_CONTRACTS_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  IDENTITIES_TABLE,
  TDH_GRANT_TOKENS_TABLE,
  TDH_GRANTS_TABLE,
  X_TDH_COEFFICIENT,
  XTDH_STATS_META_TABLE,
  XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX,
  XTDH_TOKEN_STATS_TABLE_PREFIX
} from '../constants';
import { Logger } from '../logging';
import { env } from '../env';
import { Time } from '../time';
import { TdhGrantStatus, TdhGrantTokenMode } from '../entities/ITdhGrant';
import { collections } from '../collections';
import { XTdhStatsMetaEntity } from '../entities/IXTdhStatsMeta';
import { NotFoundException } from '../exceptions';

const CTE_EPOCH = `
epoch AS (
  SELECT :x_tdh_epoch_ms AS epoch_ms
)`;

const CTE_CUTOFF = `
cutoff AS (
  SELECT UNIX_TIMESTAMP(DATE(UTC_TIMESTAMP())) * 1000 AS cut_ms
)`;

const CTE_GR_BASE = `
gr AS (
  SELECT
    g.id,
    g.target_partition,
    g.token_mode,
    g.tdh_rate,
    g.valid_from,
    g.valid_to
  FROM ${TDH_GRANTS_TABLE} g
  WHERE g.status = 'GRANTED'
    AND g.valid_from < (SELECT cut_ms FROM cutoff)
)`;

const CTE_GR_WITH_GRANTOR = `
gr AS (
  SELECT
    g.id,
    g.grantor_id,
    g.target_partition,
    g.token_mode,
    g.tdh_rate,
    g.valid_from,
    g.valid_to
  FROM ${TDH_GRANTS_TABLE} g
  WHERE g.status = 'GRANTED'
    AND g.valid_from < (SELECT cut_ms FROM cutoff)
)`;

const CTE_INC_COUNTS = `
inc_counts AS (
  SELECT
    g.id AS grant_id,
    COUNT(*) AS inc_cnt
  FROM ${TDH_GRANTS_TABLE} g
  JOIN ${TDH_GRANT_TOKENS_TABLE} t
    ON t.tokenset_id      = g.tokenset_id
   AND t.target_partition = g.target_partition
  WHERE g.status = 'GRANTED'
    AND g.token_mode = 'INCLUDE'
  GROUP BY g.id
)
`;

const CTE_GRANT_DIVISOR = `
grant_divisor AS (
  SELECT
    gr.id,
    CASE
      WHEN gr.token_mode = 'ALL' THEN COALESCE(c.total_supply, 0)
      ELSE COALESCE(ic.inc_cnt, 0)
    END AS denom
  FROM gr
  LEFT JOIN ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c
    ON c.\`partition\` = gr.target_partition
  LEFT JOIN inc_counts ic
    ON ic.grant_id = gr.id
)`;

const CTE_GRANT_TOKENS = `
grant_tokens AS (
  SELECT DISTINCT
    gr.id               AS grant_id,
    gr.target_partition AS \`partition\`,
    h.token_id
  FROM gr
  JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
    ON h.\`partition\` = gr.target_partition
  WHERE gr.token_mode = '${TdhGrantTokenMode.ALL}'

  UNION ALL

  SELECT DISTINCT
    g.id               AS grant_id,
    g.target_partition AS \`partition\`,
    CAST(t.token_id AS CHAR) AS token_id
  FROM ${TDH_GRANTS_TABLE} g
  JOIN ${TDH_GRANT_TOKENS_TABLE} t
    ON t.tokenset_id      = g.tokenset_id
   AND t.target_partition = g.target_partition
  JOIN gr ON gr.id = g.id
  WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
)`;

const CTE_CK_MAP = `
ck_map AS (
  SELECT ack.address AS addr, ack.consolidation_key AS ck
  FROM ${ADDRESS_CONSOLIDATION_KEY} ack
)`;

const CTE_OWNERS_AT_CUT = `
owners_at_cut AS (
  SELECT
    h.\`partition\`,
    h.token_id,
    h.owner,
    cm.ck AS owner_ck,
    h.since_time,
    h.block_number,
    h.log_index,
    ROW_NUMBER() OVER (
      PARTITION BY h.\`partition\`, h.token_id
      ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
    ) AS rn
  FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
  JOIN cutoff c
    ON h.since_time < c.cut_ms
  LEFT JOIN ck_map cm ON cm.addr = h.owner
)
`;

const CTE_HIST_PRE_CUT = `
hist_pre_cut AS (
  SELECT
    h.\`partition\`,
    h.token_id,
    h.owner AS new_owner,
    h.acquired_as_sale,
    h.since_time,
    h.block_number,
    h.log_index,
    LAG(h.owner) OVER (
      PARTITION BY h.\`partition\`, h.token_id
      ORDER BY h.since_time, h.block_number, h.log_index
    ) AS prev_owner
  FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
  JOIN cutoff c
    ON h.since_time <= (SELECT cut_ms FROM cutoff)
)
`;

const CTE_LAST_RESET = `
last_reset AS (
  SELECT
    o.\`partition\`,
    o.token_id,
    o.owner,
    o.owner_ck,
    MAX(h.since_time) AS reset_since_time
  FROM owners_at_cut o
  JOIN hist_pre_cut h
    ON h.\`partition\` = o.\`partition\`
   AND h.token_id    = o.token_id
   AND h.new_owner   = o.owner
   AND h.since_time <= (SELECT cut_ms FROM cutoff)
  LEFT JOIN ck_map cm_prev ON cm_prev.addr = h.prev_owner
  WHERE o.rn = 1
    AND (
      h.acquired_as_sale = 1
      OR h.prev_owner IS NULL
      OR cm_prev.ck IS NULL
      OR cm_prev.ck <> o.owner_ck
    )
  GROUP BY o.\`partition\`, o.token_id, o.owner, o.owner_ck
)
`;

const withSql = (ctes: string[], tail: string) =>
  `WITH\n${ctes.join(',\n')}\n${tail}`;

export class XTdhRepository extends LazyDbAccessCompatibleService {
  private readonly logger = Logger.get(this.constructor.name);

  async getWalletsWithoutIdentities(ctx: RequestContext): Promise<string[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getWalletsWithoutIdentities`);

      const sql = withSql(
        [
          CTE_CUTOFF,
          `
            gr AS (
              SELECT
                g.id,
                g.tokenset_id,
                g.target_partition,
                g.token_mode
              FROM ${TDH_GRANTS_TABLE} g
              WHERE g.status = 'GRANTED'
            )
      `,
          `
            grant_tokens AS (
              SELECT DISTINCT
                gr.id        AS grant_id,
                gr.target_partition AS \`partition\`,
                h.token_id
              FROM gr
              JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
                ON h.\`partition\` = gr.target_partition
              WHERE gr.token_mode = 'ALL'
            
              UNION ALL
            
              SELECT DISTINCT
                g.id         AS grant_id,
                g.target_partition AS \`partition\`,
                CAST(t.token_id AS CHAR) AS token_id
              FROM ${TDH_GRANTS_TABLE} g
              JOIN ${TDH_GRANT_TOKENS_TABLE} t
                ON t.tokenset_id     = g.tokenset_id
               AND t.target_partition = g.target_partition
              JOIN gr ON gr.id = g.id
              WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
            )
      `,
          `
      owners_at_cut AS (
        SELECT
          h.\`partition\`,
          h.token_id,
          h.owner,
          ROW_NUMBER() OVER (
            PARTITION BY h.\`partition\`, h.token_id
            ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
          ) AS rn
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        JOIN cutoff c
          ON h.since_time < c.cut_ms
      )`
        ],
        `
      SELECT DISTINCT o.owner AS wallet
      FROM grant_tokens gt
      JOIN owners_at_cut o
        ON o.\`partition\` = gt.\`partition\`
       AND o.token_id     = gt.token_id
       AND o.rn = 1
      LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
        ON ack.address = o.owner
      WHERE ack.address IS NULL
      `
      );

      return collections.distinct(
        await this.db
          .execute<{
            wallet: string;
          }>(sql, undefined, { wrappedConnection: ctx.connection })
          .then((res) => res.map((it) => it.wallet))
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getWalletsWithoutIdentities`);
    }
  }

  async deleteXTdhState(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteXTdhState`);
      await this.db.execute(
        `UPDATE ${IDENTITIES_TABLE} SET xtdh = 0, xtdh_rate = 0`,
        undefined,
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteXTdhState`);
    }
  }

  private getDaysSinceXTdhEpoch(): number {
    const epochTime = Time.fromDdMmYyyyDateOnlyToUtcMidnight(
      env.getStringOrThrow('XTDH_EPOCH_DATE')
    );
    const latestUtcMidnight = Time.latestUtcMidnight();
    if (latestUtcMidnight.lt(epochTime)) {
      return 0;
    }
    return Math.floor(latestUtcMidnight.diff(epochTime).toDays());
  }

  private getXTdhEpochMillis(): number {
    const epochTime = Time.fromDdMmYyyyDateOnlyToUtcMidnight(
      env.getStringOrThrow('XTDH_EPOCH_DATE')
    );
    return epochTime.toMillis();
  }

  async updateProducedXTDH(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateProducedXTDH`);
      this.logger.info(`Clearing produced xTDH in ${IDENTITIES_TABLE}`);
      await this.db.execute(
        `
        UPDATE ${IDENTITIES_TABLE}
        SET produced_xtdh = 0
        WHERE produced_xtdh <> 0
      `,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      this.logger.info(`Setting produced xTDH in ${IDENTITIES_TABLE}`);
      const sql = `
        UPDATE ${IDENTITIES_TABLE} c
          LEFT JOIN (
            SELECT
              c.consolidation_key,
              SUM(e.hodl_rate * LEAST(e.days_held, :days_since_epoch))
                * COALESCE(MAX(c.boost), 1.0)
                * ${X_TDH_COEFFICIENT} AS produced_xtdh
            FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} c
                   LEFT JOIN ${CONSOLIDATED_TDH_EDITIONS_TABLE} e
                             ON e.consolidation_key = c.consolidation_key
            GROUP BY c.consolidation_key
          ) x
          ON x.consolidation_key = c.consolidation_key
        SET c.produced_xtdh = COALESCE(x.produced_xtdh, 0);
  `;
      const params = { days_since_epoch: this.getDaysSinceXTdhEpoch() };
      await this.db.execute(sql, params, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateProducedXTDH`);
    }
  }

  async updateAllGrantedXTdhs(ctx: RequestContext) {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->updateAllGrantedXTdhsOnConsolidated`
      );
      this.logger.info(`Zeroing out granted_xtdh`);
      await this.db.execute(
        `
        UPDATE ${IDENTITIES_TABLE}
        SET granted_xtdh = 0
        WHERE granted_xtdh <> 0
      `,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      this.logger.info(`Zeroed out granted_xtdh`);

      const sql = withSql(
        [
          CTE_EPOCH,
          CTE_CK_MAP,
          CTE_CUTOFF,
          CTE_GR_WITH_GRANTOR,
          CTE_INC_COUNTS,
          CTE_GRANT_DIVISOR,
          CTE_GRANT_TOKENS,
          CTE_OWNERS_AT_CUT,
          CTE_HIST_PRE_CUT,
          CTE_LAST_RESET,
          `
bounded_windows AS (
  SELECT
    gto.grant_id,
    gto.\`partition\`,
    gto.token_id,
    gto.owner,
    GREATEST(
      gto.group_start_ms,
      gr.valid_from,
      (SELECT epoch_ms FROM epoch)
    ) AS start_ms,
    LEAST((SELECT cut_ms FROM cutoff), COALESCE(gr.valid_to, (SELECT cut_ms FROM cutoff))) AS end_ms,
    gr.tdh_rate,
    gd.denom,
    gr.grantor_id
  FROM (
    SELECT
      gt.grant_id,
      gt.\`partition\`,
      gt.token_id,
      o.owner,
      lr.reset_since_time AS group_start_ms
    FROM grant_tokens gt
    JOIN owners_at_cut o
      ON o.\`partition\` = gt.\`partition\`
     AND o.token_id    = gt.token_id
     AND o.rn = 1
    LEFT JOIN last_reset lr
      ON lr.\`partition\` = gt.\`partition\`
     AND lr.token_id    = gt.token_id
     AND lr.owner       = o.owner
  ) gto
  JOIN gr  ON gr.id = gto.grant_id
  JOIN grant_divisor gd ON gd.id = gr.id
  WHERE gto.group_start_ms IS NOT NULL
)`,
          `
days_owned AS (
  SELECT
    bw.grant_id,
    bw.\`partition\`,
    bw.token_id,
    bw.grantor_id,
    GREATEST(
      0,
      DATEDIFF(
        DATE(FROM_UNIXTIME(bw.end_ms   / 1000)),
        DATE(FROM_UNIXTIME(bw.start_ms / 1000))
      ) - 1
    ) AS full_days,
    bw.tdh_rate,
    bw.denom
  FROM bounded_windows bw
  WHERE bw.end_ms > bw.start_ms
)`,
          `
token_contrib AS (
  SELECT
    grantor_id,
    CASE WHEN denom > 0 THEN (tdh_rate / denom) * full_days ELSE 0 END AS x
  FROM days_owned
)`,
          `
ck_xtdh AS (
  SELECT
    i.consolidation_key,
    SUM(tc.x) AS total_granted_xtdh
  FROM token_contrib tc
  JOIN ${IDENTITIES_TABLE} i
    ON i.profile_id = tc.grantor_id
  GROUP BY i.consolidation_key
)`
        ],
        `
          UPDATE ${IDENTITIES_TABLE} cw
            LEFT JOIN ck_xtdh gx
            ON gx.consolidation_key = cw.consolidation_key
          SET cw.granted_xtdh = COALESCE(gx.total_granted_xtdh, 0)
        `
      );

      await this.db.execute(
        sql,
        { x_tdh_epoch_ms: this.getXTdhEpochMillis() },
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->updateAllGrantedXTdhsOnConsolidated`
      );
    }
  }

  async updateAllXTdhsWithGrantedPart(ctx: RequestContext) {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->updateAllXTdhsWithGrantedPartOnConsolidated`
      );

      const sql = withSql(
        [
          CTE_EPOCH,
          CTE_CK_MAP,
          CTE_CUTOFF,
          CTE_GR_BASE,
          CTE_INC_COUNTS,
          CTE_GRANT_DIVISOR,
          CTE_GRANT_TOKENS,
          CTE_OWNERS_AT_CUT,
          CTE_HIST_PRE_CUT,
          CTE_LAST_RESET,
          `
          bounded_windows AS (
            SELECT
              gto.grant_id,
              gto.\`partition\`,
              gto.token_id,
              gto.owner,
              GREATEST(gto.group_start_ms, gr.valid_from, (SELECT epoch_ms FROM epoch)) AS start_ms,
              LEAST((SELECT cut_ms FROM cutoff), COALESCE(gr.valid_to, (SELECT cut_ms FROM cutoff))) AS end_ms,
              gr.tdh_rate,
              gd.denom
            FROM (
              SELECT
                gt.grant_id,
                gt.\`partition\`,
                gt.token_id,
                o.owner,
                lr.reset_since_time AS group_start_ms
              FROM grant_tokens gt
              JOIN owners_at_cut o
                ON o.\`partition\` = gt.\`partition\`
               AND o.token_id    = gt.token_id
               AND o.rn = 1
              LEFT JOIN last_reset lr
                ON lr.\`partition\` = gt.\`partition\`
               AND lr.token_id    = gt.token_id
               AND lr.owner       = o.owner
            ) gto
            JOIN gr  ON gr.id = gto.grant_id
            JOIN grant_divisor gd ON gd.id = gr.id
            WHERE gto.group_start_ms IS NOT NULL
          )
          `,
          `
          days_owned AS (
            SELECT
              bw.grant_id,
              bw.\`partition\`,
              bw.token_id,
              bw.owner,
              GREATEST(
                0,
                DATEDIFF(
                  DATE(FROM_UNIXTIME(bw.end_ms   / 1000)),
                  DATE(FROM_UNIXTIME(bw.start_ms / 1000))
                ) - 1
              ) AS full_days,
              bw.tdh_rate,
              bw.denom
            FROM bounded_windows bw
            WHERE bw.end_ms > bw.start_ms
          )
          `,
          `
          token_contrib AS (
            SELECT
              owner,
              CASE WHEN denom > 0 THEN (tdh_rate / denom) * full_days ELSE 0 END AS x
            FROM days_owned
          )
          `,
          `
          wallet_xtdh AS (
            SELECT owner, SUM(x) AS total_xtdh
            FROM token_contrib
            GROUP BY owner
          )
          `,
          `
          consolidated_xtdh AS (
            SELECT
              ack.consolidation_key,
              SUM(w.total_xtdh) AS total_xtdh
            FROM wallet_xtdh w
            LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack ON ack.address = w.owner
            GROUP BY ack.consolidation_key
          )
        `
        ],
        `
        UPDATE ${IDENTITIES_TABLE} cw
        LEFT JOIN consolidated_xtdh cx
          ON cx.consolidation_key = cw.consolidation_key
        SET cw.xtdh = COALESCE(cx.total_xtdh, 0)
        `
      );
      await this.db.execute(
        sql,
        { x_tdh_epoch_ms: this.getXTdhEpochMillis() },
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->updateAllXTdhsWithGrantedPartOnConsolidated`
      );
    }
  }

  public async giveOutUngrantedXTdh(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->giveOutUngrantedXTdh`);
      await this.db.execute(
        `UPDATE ${IDENTITIES_TABLE} SET xtdh = xtdh + (produced_xtdh - granted_xtdh)`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->updateAllXTdhsWithGrantedPart`
      );
    }
  }

  async updateXtdhRate(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateXtdhRate`);

      const sql = withSql(
        [
          CTE_EPOCH,
          CTE_CK_MAP,
          CTE_CUTOFF,

          `
produced_day AS (
  SELECT
    c.consolidation_key,
    SUM(e.hodl_rate) * COALESCE(MAX(c.boost), 1.0) * ${X_TDH_COEFFICIENT} AS produced
  FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} c
  LEFT JOIN ${CONSOLIDATED_TDH_EDITIONS_TABLE} e
    ON e.consolidation_key = c.consolidation_key
  GROUP BY c.consolidation_key
)`,
          CTE_GR_WITH_GRANTOR,
          CTE_INC_COUNTS,
          CTE_GRANT_DIVISOR,
          CTE_GRANT_TOKENS,
          CTE_OWNERS_AT_CUT,
          CTE_HIST_PRE_CUT,
          CTE_LAST_RESET,

          `
bounded_windows AS (
  SELECT
    gto.grant_id,
    gto.\`partition\`,
    gto.token_id,
    gto.owner,
    GREATEST(
      gto.group_start_ms,
      gr.valid_from,
      (SELECT epoch_ms FROM epoch)
    ) AS start_ms,
    LEAST((SELECT cut_ms FROM cutoff), COALESCE(gr.valid_to, (SELECT cut_ms FROM cutoff))) AS end_ms,
    gr.tdh_rate,
    gd.denom,
    gr.grantor_id
  FROM (
    SELECT
      gt.grant_id,
      gt.\`partition\`,
      gt.token_id,
      o.owner,
      lr.reset_since_time AS group_start_ms
    FROM grant_tokens gt
    JOIN owners_at_cut o
      ON o.\`partition\` = gt.\`partition\`
     AND o.token_id    = gt.token_id
     AND o.rn = 1
    LEFT JOIN last_reset lr
      ON lr.\`partition\` = gt.\`partition\`
     AND lr.token_id    = gt.token_id
     AND lr.owner       = o.owner
  ) gto
  JOIN gr  ON gr.id = gto.grant_id
  JOIN grant_divisor gd ON gd.id = gr.id
  WHERE gto.group_start_ms IS NOT NULL
)`,
          `
days_owned AS (
  SELECT
    bw.grant_id,
    bw.\`partition\`,
    bw.token_id,
    bw.owner,
    bw.grantor_id,
    bw.tdh_rate,
    bw.denom,
    bw.start_ms,
    (SELECT cut_ms FROM cutoff) AS cut_ms,
    -- full-days accrued up to last midnight
    GREATEST(
      0,
      DATEDIFF(
        DATE(FROM_UNIXTIME(bw.end_ms   / 1000)),
        DATE(FROM_UNIXTIME(bw.start_ms / 1000))
      ) - 1
    ) AS full_days,
    -- # of midnights since start
    TIMESTAMPDIFF(DAY,
      FROM_UNIXTIME(bw.start_ms / 1000),
      FROM_UNIXTIME((SELECT cut_ms FROM cutoff) / 1000)
    ) AS days_since_start
  FROM bounded_windows bw
  WHERE bw.end_ms > bw.start_ms
)`,
          `
grant_out_day AS (
  SELECT
    i.consolidation_key,
    SUM(CASE WHEN d.denom > 0
             AND d.full_days > 0
             AND d.days_since_start >= 2
             THEN (d.tdh_rate / d.denom)
             ELSE 0 END) AS granted_out
  FROM days_owned d
  JOIN ${IDENTITIES_TABLE} i
    ON i.profile_id = d.grantor_id
  GROUP BY i.consolidation_key
)`,
          `
received_day AS (
  SELECT
    ack.consolidation_key,
    SUM(CASE WHEN d.denom > 0
             AND d.full_days > 0
             AND d.days_since_start >= 2
             THEN (d.tdh_rate / d.denom)
             ELSE 0 END) AS received
  FROM days_owned d
  LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
    ON ack.address = d.owner
  GROUP BY ack.consolidation_key
)`
        ],
        `
UPDATE ${IDENTITIES_TABLE} cw
LEFT JOIN produced_day pd
  ON pd.consolidation_key = cw.consolidation_key
LEFT JOIN grant_out_day go
  ON go.consolidation_key = cw.consolidation_key
LEFT JOIN received_day rd
  ON rd.consolidation_key = cw.consolidation_key
SET cw.xtdh_rate = COALESCE(pd.produced, 0) - COALESCE(go.granted_out, 0) + COALESCE(rd.received, 0)
`
      );

      await this.db.execute(
        sql,
        { x_tdh_epoch_ms: this.getXTdhEpochMillis() },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateXtdhRate`);
    }
  }

  public async getStatsMetaOrNull(
    ctx: RequestContext
  ): Promise<XTdhStatsMetaEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getStatsMetaOrNull`);
      return this.db.oneOrNull<XTdhStatsMetaEntity>(
        `select * from ${XTDH_STATS_META_TABLE} where id = 1`
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getStatsMetaOrNull`);
    }
  }

  public async getStatsMetaOrThrow(
    ctx: RequestContext
  ): Promise<XTdhStatsMetaEntity> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getStatsMetaOrThrow`);
      const meta = await this.getStatsMetaOrNull(ctx);
      if (!meta) {
        throw new NotFoundException(
          `${XTDH_STATS_META_TABLE} is missing an entry`
        );
      }
      return meta;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getStatsMetaOrThrow`);
    }
  }

  public async refillXTdhTokenStats(
    {
      slot
    }: {
      slot: 'a' | 'b';
    },
    ctx: RequestContext
  ) {
    const TABLE = `${XTDH_TOKEN_STATS_TABLE_PREFIX}${slot}`;
    const GRANT_TABLE = `${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot}`;

    try {
      ctx.timer?.start(`${this.constructor.name}->refillXTdhTokenStats`);

      const cutoffSql = `SELECT UNIX_TIMESTAMP(DATE(UTC_TIMESTAMP())) * 1000 AS cut_ms`;
      const [{ cut_ms }] = await this.db.execute<{ cut_ms: number }>(
        cutoffSql,
        {},
        { wrappedConnection: ctx.connection }
      );

      await this.db.execute(
        `TRUNCATE TABLE ${TABLE}`,
        {},
        { wrappedConnection: ctx.connection }
      );

      const sql = `
        INSERT INTO ${TABLE} (
          \`partition\`,
          token_id,
          owner,
          xtdh_total,
          xtdh_rate_daily,
          grant_count,
          total_contributor_count,
          active_contributor_count
        )
        WITH
          cutoff AS (
            SELECT :cut_ms AS cut_ms
          ),

          owners_at_cut AS (
            SELECT
              h.\`partition\`,
              h.token_id,
              h.owner,
              ROW_NUMBER() OVER (
                PARTITION BY h.\`partition\`, h.token_id
                ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
                ) AS rn
            FROM external_indexed_ownership_721_histories h
                   JOIN cutoff c ON h.since_time < c.cut_ms
          ),

          -- per-token aggregates: xtdh, rate, grant_count
          token_agg AS (
            SELECT
              g.\`partition\`,
              g.token_id,
              SUM(g.xtdh_total)      AS xtdh_total,
              SUM(g.xtdh_rate_daily) AS xtdh_rate_daily,
              COUNT(DISTINCT g.grant_id) AS grant_count
            FROM ${GRANT_TABLE} g
            GROUP BY g.\`partition\`, g.token_id
          ),

          -- contributor map: distinct grantors per token
          contrib AS (
            SELECT
              gts.\`partition\`,
              gts.token_id,
              tg.grantor_id,
              (gts.xtdh_rate_daily > 0) AS contributed_last_midnight
            FROM ${GRANT_TABLE} gts
                   JOIN tdh_grants tg ON tg.id = gts.grant_id
          ),

          total_contrib AS (
            SELECT
              \`partition\`,
              token_id,
              COUNT(DISTINCT grantor_id) AS total_contributor_count
            FROM contrib
            GROUP BY \`partition\`, token_id
          ),

          active_contrib AS (
            SELECT
              \`partition\`,
              token_id,
              COUNT(DISTINCT grantor_id) AS active_contributor_count
            FROM contrib
            WHERE contributed_last_midnight = 1
            GROUP BY \`partition\`, token_id
          )

        SELECT
          ta.\`partition\`,
          ta.token_id,
          COALESCE(
            o.owner,
            '0x0000000000000000000000000000000000000000'
          ) AS owner,
          ta.xtdh_total,
          ta.xtdh_rate_daily,
          ta.grant_count,
          COALESCE(tc.total_contributor_count, 0)  AS total_contributor_count,
          COALESCE(ac.active_contributor_count, 0) AS active_contributor_count
        FROM token_agg ta
               LEFT JOIN owners_at_cut o
                         ON o.\`partition\` = ta.\`partition\`
                           AND o.token_id      = ta.token_id
                           AND o.rn = 1
               LEFT JOIN total_contrib tc
                         ON tc.\`partition\` = ta.\`partition\`
                           AND tc.token_id      = ta.token_id
               LEFT JOIN active_contrib ac
                         ON ac.\`partition\` = ta.\`partition\`
                           AND ac.token_id      = ta.token_id
      `;

      await this.db.execute(
        sql,
        { cut_ms },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->refillXTdhTokenStats`);
    }
  }

  public async refillXTdhGrantStats(
    {
      slot
    }: {
      slot: 'a' | 'b';
    },
    ctx: RequestContext
  ) {
    const TABLE = XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX + slot;

    try {
      ctx.timer?.start(`${this.constructor.name}->refillXTdhGrantStats`);

      const epochMs = this.getXTdhEpochMillis();

      await this.db.execute(`TRUNCATE TABLE ${TABLE}`, undefined, {
        wrappedConnection: ctx.connection
      });

      const sql = `
      INSERT INTO ${TABLE} (
        grant_id,
        \`partition\`,
        token_id,
        xtdh_total,
        xtdh_rate_daily
      )
      WITH
        epoch AS (
          SELECT :x_tdh_epoch_ms AS epoch_ms
        ),
        cutoff AS (
          -- last UTC midnight in ms
          SELECT UNIX_TIMESTAMP(DATE(UTC_TIMESTAMP())) * 1000 AS cut_ms
        ),
        -- eligible grants
        gr AS (
          SELECT
            g.id,
            g.target_partition,
            g.token_mode,
            g.tdh_rate,
            g.valid_from,
            g.valid_to
          FROM ${TDH_GRANTS_TABLE} g
          WHERE g.status = '${TdhGrantStatus.GRANTED}'
            AND g.tdh_rate > 0
            AND g.valid_from < (SELECT cut_ms FROM cutoff)
        ),
        -- include-counts only for INCLUDE grants (for denom)
        inc_counts AS (
          SELECT
            g.id AS grant_id,
            COUNT(*) AS inc_cnt
          FROM ${TDH_GRANTS_TABLE} g
          JOIN ${TDH_GRANT_TOKENS_TABLE} t
            ON t.tokenset_id      = g.tokenset_id
           AND t.target_partition = g.target_partition
          WHERE g.status = '${TdhGrantStatus.GRANTED}'
            AND g.token_mode = '${TdhGrantTokenMode.INCLUDE}'
          GROUP BY g.id
        ),
        grant_divisor AS (
          SELECT
            gr.id,
            CASE
              WHEN gr.token_mode = '${TdhGrantTokenMode.ALL}' THEN COALESCE(c.total_supply, 0)
              ELSE COALESCE(ic.inc_cnt, 0)
            END AS denom
          FROM gr
          LEFT JOIN ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c
            ON c.\`partition\` = gr.target_partition
          LEFT JOIN inc_counts ic
            ON ic.grant_id = gr.id
        ),
        -- universe of targeted (grant_id, partition, token_id)
        grant_tokens AS (
          -- ALL-mode: all tokens that have ever appeared in history
          SELECT DISTINCT
            gr.id               AS grant_id,
            gr.target_partition AS \`partition\`,
            h.token_id          AS token_id
          FROM gr
          JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
            ON h.\`partition\` = gr.target_partition
          WHERE gr.token_mode = '${TdhGrantTokenMode.ALL}'

          UNION ALL

          -- INCLUDE-mode: tokens from tdh_grant_tokens
          SELECT DISTINCT
            g.id               AS grant_id,
            g.target_partition AS \`partition\`,
            t.token_id         AS token_id
          FROM ${TDH_GRANTS_TABLE} g
          JOIN ${TDH_GRANT_TOKENS_TABLE} t
            ON t.tokenset_id      = g.tokenset_id
           AND t.target_partition = g.target_partition
          JOIN gr ON gr.id = g.id
          WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
        ),
        bounded_windows AS (
          SELECT
            gt.grant_id,
            gt.\`partition\`,
            gt.token_id,
            GREATEST(
              gr.valid_from,
              (SELECT epoch_ms FROM epoch)
            ) AS start_ms,
            LEAST(
              COALESCE(gr.valid_to, (SELECT cut_ms FROM cutoff)),
              (SELECT cut_ms FROM cutoff)
            ) AS end_ms,
            gr.tdh_rate,
            gd.denom,
            (SELECT cut_ms FROM cutoff) AS cut_ms
          FROM grant_tokens gt
          JOIN gr  ON gr.id = gt.grant_id
          JOIN grant_divisor gd ON gd.id = gr.id
        ),
        days_owned AS (
          SELECT
            bw.grant_id,
            bw.\`partition\`,
            bw.token_id,
            GREATEST(
              0,
              DATEDIFF(
                DATE(FROM_UNIXTIME(bw.end_ms   / 1000)),
                DATE(FROM_UNIXTIME(bw.start_ms / 1000))
              ) - 1
            ) AS full_days,
            TIMESTAMPDIFF(
              DAY,
              FROM_UNIXTIME(bw.start_ms / 1000),
              FROM_UNIXTIME(bw.cut_ms   / 1000)
            ) AS days_since_start,
            bw.tdh_rate,
            bw.denom
          FROM bounded_windows bw
          WHERE bw.end_ms > bw.start_ms
        ),
        grant_token_xtdh AS (
          SELECT
            d.grant_id,
            d.\`partition\`,
            d.token_id,
            -- TOTAL: sum over all full days
            SUM(
              (d.tdh_rate / NULLIF(d.denom, 0)) * d.full_days
            ) AS raw_xtdh,
            -- RATE for last midnight: one-day increment if "matured" (>= 2 days since start)
            SUM(
              CASE
                WHEN d.denom > 0 AND d.full_days > 0 AND d.days_since_start >= 2
                  THEN (d.tdh_rate / d.denom)
                ELSE 0
              END
            ) AS raw_xtdh_rate
          FROM days_owned d
          GROUP BY d.grant_id, d.\`partition\`, d.token_id
        )
      SELECT
        gtx.grant_id,
        gtx.\`partition\`,
        gtx.token_id,
        gtx.raw_xtdh      * ${X_TDH_COEFFICIENT} AS xtdh_total,
        gtx.raw_xtdh_rate * ${X_TDH_COEFFICIENT} AS xtdh_rate_daily
      FROM grant_token_xtdh gtx
      WHERE gtx.raw_xtdh > 0
    `;

      await this.db.execute(
        sql,
        { x_tdh_epoch_ms: epochMs },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->refillXTdhGrantStats`);
    }
  }

  async markStatsJustReindexed(
    { slot }: { slot: 'a' | 'b' },
    ctx: RequestContext
  ) {
    try {
      ctx.timer?.start(`${this.constructor.name}->markStatsJustReindexed`);
      const lastMidnightMillis = Time.latestUtcMidnight().toMillis();
      const now = Time.now().toDate();
      await this.db.execute(
        `
            insert into ${XTDH_STATS_META_TABLE} (
                                      id, 
                                      active_slot, 
                                      as_of_midnight_ms, 
                                      last_updated_at
                                    ) values (
                                      :id,
                                      :active_slot,
                                      :as_of_midnight_ms,
                                      :last_updated_at
                                    ) on duplicate key update active_slot = :active_slot, as_of_midnight_ms = :as_of_midnight_ms, last_updated_at = :last_updated_at
    `,
        {
          id: 1,
          active_slot: slot,
          as_of_midnight_ms: lastMidnightMillis,
          last_updated_at: now
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->markStatsJustReindexed`);
    }
  }

  private async getActiveStatsTables(ctx: RequestContext): Promise<{
    tokenStatsTable: string;
    grantStatsTable: string;
  }> {
    const slot = await this.getActiveStatsSlot(ctx);
    return {
      tokenStatsTable: `${XTDH_TOKEN_STATS_TABLE_PREFIX}${slot}`,
      grantStatsTable: `${XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX}${slot}`
    };
  }

  public async getActiveStatsSlot(ctx: RequestContext): Promise<'a' | 'b'> {
    const meta = await this.getStatsMetaOrThrow(ctx);
    return meta.active_slot;
  }

  async getXTdhCollections(
    {
      identityId,
      offset,
      limit,
      sort,
      order
    }: {
      identityId: string | null;
      offset: number;
      limit: number;
      sort: 'xtdh' | 'xtdh_rate';
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<
    Array<{
      contract: string;
      xtdh: number;
      xtdh_rate: number;
      total_token_count: number;
      active_token_count: number;
      total_contributors_count: number;
      active_contributors_count: number;
    }>
  > {
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhCollections`);
      const { tokenStatsTable, grantStatsTable } =
        await this.getActiveStatsTables(ctx);

      // --- FAST PATH: global leaderboard (no identity filter) ---
      if (!identityId) {
        const sql = `
        WITH
        coll_agg AS (
          SELECT
            s.\`partition\`,
            SUM(s.xtdh_total)      AS xtdh,
            SUM(s.xtdh_rate_daily) AS xtdh_rate
          FROM ${tokenStatsTable} s
          GROUP BY s.\`partition\`
        ),

        token_totals AS (
          SELECT
            s.\`partition\`,
            COUNT(*) AS total_token_count
          FROM ${tokenStatsTable} s
          WHERE s.xtdh_total > 0
          GROUP BY s.\`partition\`
        ),

        token_active AS (
          SELECT
            s.\`partition\`,
            COUNT(*) AS active_token_count
          FROM ${tokenStatsTable} s
          WHERE s.xtdh_rate_daily > 0
          GROUP BY s.\`partition\`
        ),

        contrib_base AS (
          SELECT DISTINCT
            gts.\`partition\`,
            g.grantor_id,
            (gts.xtdh_rate_daily > 0) AS contributed_last_midnight
          FROM ${grantStatsTable} gts
          JOIN ${TDH_GRANTS_TABLE} g
            ON g.id = gts.grant_id
          WHERE g.status = '${TdhGrantStatus.GRANTED}'
            AND gts.xtdh_total > 0
        ),

        total_contrib AS (
          SELECT
            cb.\`partition\`,
            COUNT(DISTINCT cb.grantor_id) AS total_contributors_count
          FROM contrib_base cb
          GROUP BY cb.\`partition\`
        ),

        active_contrib AS (
          SELECT
            cb.\`partition\`,
            COUNT(DISTINCT cb.grantor_id) AS active_contributors_count
          FROM contrib_base cb
          WHERE cb.contributed_last_midnight = 1
          GROUP BY cb.\`partition\`
        )

        SELECT
          ca.\`partition\`,
          ca.xtdh,
          ca.xtdh_rate,
          COALESCE(tt.total_token_count, 0)          AS total_token_count,
          COALESCE(ta.active_token_count, 0)         AS active_token_count,
          COALESCE(tc.total_contributors_count, 0)   AS total_contributors_count,
          COALESCE(ac.active_contributors_count, 0)  AS active_contributors_count
        FROM coll_agg ca
        LEFT JOIN token_totals   tt ON tt.\`partition\` = ca.\`partition\`
        LEFT JOIN token_active   ta ON ta.\`partition\` = ca.\`partition\`
        LEFT JOIN total_contrib  tc ON tc.\`partition\` = ca.\`partition\`
        LEFT JOIN active_contrib ac ON ac.\`partition\` = ca.\`partition\`
        ORDER BY ${sort} ${order}
        LIMIT :limit OFFSET :offset
      `;

        const rows = await this.db.execute<{
          partition: string;
          xtdh: number;
          xtdh_rate: number;
          total_token_count: number;
          active_token_count: number;
          total_contributors_count: number;
          active_contributors_count: number;
        }>(sql, { limit, offset }, { wrappedConnection: ctx.connection });

        return rows.map((it) => ({
          contract: it.partition.substring(2),
          xtdh: +it.xtdh,
          xtdh_rate: +it.xtdh_rate,
          total_token_count: +it.total_token_count,
          active_token_count: +it.active_token_count,
          total_contributors_count: +it.total_contributors_count,
          active_contributors_count: +it.active_contributors_count
        }));
      }

      const sqlWithIdentity = `
      WITH ts AS (
        SELECT
          s.\`partition\`,
          s.token_id,
          s.owner,
          s.xtdh_total,
          s.xtdh_rate_daily,
          s.grant_count
        FROM ${tokenStatsTable} s
        LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
          ON ack.address = s.owner
        LEFT JOIN ${IDENTITIES_TABLE} i
          ON i.consolidation_key = ack.consolidation_key
        WHERE (:identityId IS NULL OR i.profile_id = :identityId)
      ),

      coll_agg AS (
        SELECT
          ts.\`partition\`,
          SUM(ts.xtdh_total)      AS xtdh,
          SUM(ts.xtdh_rate_daily) AS xtdh_rate
        FROM ts
        GROUP BY ts.\`partition\`
      ),

      token_totals AS (
        SELECT
          ts.\`partition\`,
          COUNT(*) AS total_token_count
        FROM ts
        WHERE ts.xtdh_total > 0
        GROUP BY ts.\`partition\`
      ),

      token_active AS (
        SELECT
          ts.\`partition\`,
          COUNT(*) AS active_token_count
        FROM ts
        WHERE ts.xtdh_rate_daily > 0
        GROUP BY ts.\`partition\`
      ),

      contrib_base AS (
        SELECT DISTINCT
          ts.\`partition\`,
          g.grantor_id,
          (gts.xtdh_rate_daily > 0) AS contributed_last_midnight
        FROM ts
        JOIN ${grantStatsTable} gts
          ON gts.\`partition\` = ts.\`partition\`
         AND gts.token_id    = ts.token_id
        JOIN ${TDH_GRANTS_TABLE} g
          ON g.id = gts.grant_id
        WHERE g.status = '${TdhGrantStatus.GRANTED}'
      ),

      total_contrib AS (
        SELECT
          cb.\`partition\`,
          COUNT(DISTINCT cb.grantor_id) AS total_contributors_count
        FROM contrib_base cb
        GROUP BY cb.\`partition\`
      ),

      active_contrib AS (
        SELECT
          cb.\`partition\`,
          COUNT(DISTINCT cb.grantor_id) AS active_contributors_count
        FROM contrib_base cb
        WHERE cb.contributed_last_midnight = 1
        GROUP BY cb.\`partition\`
      )

      SELECT
        ca.\`partition\`,
        ca.xtdh,
        ca.xtdh_rate,
        COALESCE(tt.total_token_count, 0)          AS total_token_count,
        COALESCE(ta.active_token_count, 0)         AS active_token_count,
        COALESCE(tc.total_contributors_count, 0)   AS total_contributors_count,
        COALESCE(ac.active_contributors_count, 0)  AS active_contributors_count
      FROM coll_agg ca
      LEFT JOIN token_totals   tt ON tt.\`partition\` = ca.\`partition\`
      LEFT JOIN token_active   ta ON ta.\`partition\` = ca.\`partition\`
      LEFT JOIN total_contrib  tc ON tc.\`partition\` = ca.\`partition\`
      LEFT JOIN active_contrib ac ON ac.\`partition\` = ca.\`partition\`
      ORDER BY ${sort} ${order}
      LIMIT :limit OFFSET :offset
    `;

      const rows = await this.db.execute<{
        partition: string;
        xtdh: number;
        xtdh_rate: number;
        total_token_count: number;
        active_token_count: number;
        total_contributors_count: number;
        active_contributors_count: number;
      }>(
        sqlWithIdentity,
        { identityId, limit, offset },
        { wrappedConnection: ctx.connection }
      );

      return rows.map((it) => ({
        contract: it.partition.substring(2),
        xtdh: +it.xtdh,
        xtdh_rate: +it.xtdh_rate,
        total_token_count: +it.total_token_count,
        active_token_count: +it.active_token_count,
        total_contributors_count: +it.total_contributors_count,
        active_contributors_count: +it.active_contributors_count
      }));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhCollections`);
    }
  }

  async getXTdhTokens(
    {
      identityId,
      contract,
      tokenId,
      offset,
      limit,
      sort,
      order
    }: {
      identityId: string | null;
      contract: string | null;
      tokenId: number | null;
      offset: number | null;
      limit: number | null;
      sort: 'xtdh' | 'xtdh_rate';
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<
    Array<{
      contract: string;
      token_id: number;
      owner_id: string;
      xtdh: number;
      xtdh_rate: number;
      total_contributor_count: number;
      active_contributor_count: number;
    }>
  > {
    const partition = contract ? `1:${contract}` : null;

    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhTokens`);

      const { tokenStatsTable } = await this.getActiveStatsTables(ctx);

      const sql = `
      SELECT
        s.\`partition\`,
        s.token_id,
        s.owner AS owner_id,
        s.xtdh_total      AS xtdh,
        s.xtdh_rate_daily AS xtdh_rate,
        s.total_contributor_count,
        s.active_contributor_count
      FROM ${tokenStatsTable} s
      LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
        ON ack.address = s.owner
      LEFT JOIN ${IDENTITIES_TABLE} i
        ON i.consolidation_key = ack.consolidation_key
      WHERE (:identityId IS NULL OR i.profile_id = :identityId)
        AND (:partition  IS NULL OR s.\`partition\` = :partition)
        AND (:tokenId    IS NULL OR s.token_id    = :tokenId)
      ORDER BY ${sort} ${order}
      LIMIT :limit OFFSET :offset
    `;

      const rows = await this.db.execute<{
        partition: string;
        token_id: number;
        owner_id: string;
        xtdh: number;
        xtdh_rate: number;
        total_contributor_count: number;
        active_contributor_count: number;
      }>(
        sql,
        { identityId, partition, tokenId, limit, offset },
        { wrappedConnection: ctx.connection }
      );

      return rows.map((it) => ({
        contract: it.partition.substring(2),
        owner_id: it.owner_id,
        token_id: +it.token_id,
        xtdh: +it.xtdh,
        xtdh_rate: +it.xtdh_rate,
        total_contributor_count: +it.total_contributor_count,
        active_contributor_count: +it.active_contributor_count
      }));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhTokens`);
    }
  }

  async getTokenContributors(
    {
      token,
      contract,
      groupBy,
      offset,
      limit,
      sort,
      order
    }: {
      token: number;
      contract: string;
      groupBy: 'grant' | 'grantor';
      offset: number | null;
      limit: number | null;
      sort: 'xtdh' | 'xtdh_rate';
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<
    Array<{
      grant_id?: string;
      grantor_id?: string;
      total_grant_count: number;
      active_grant_count: number;
      xtdh: number;
      xtdh_rate: number;
    }>
  > {
    const partition = `1:${contract}`;

    try {
      ctx.timer?.start(`${this.constructor.name}->getTokenContributors`);
      const { grantStatsTable } = await this.getActiveStatsTables(ctx);

      const selectPart =
        groupBy === 'grant'
          ? `
      SELECT
        tg.grant_id,
        gr.grantor_id AS grantor_id,
        tg.xtdh_total      AS xtdh,
        tg.xtdh_rate_daily AS xtdh_rate,
        1                  AS total_grant_count,
        CASE WHEN tg.xtdh_rate_daily > 0 THEN 1 ELSE 0 END AS active_grant_count
      FROM token_grants tg
      JOIN ${TDH_GRANTS_TABLE} gr
        ON gr.id = tg.grant_id
    `
          : `
      SELECT
        gr.grantor_id AS grantor_id,
        COUNT(*) AS total_grant_count,
        SUM(CASE WHEN tg.xtdh_rate_daily > 0 THEN 1 ELSE 0 END) AS active_grant_count,
        SUM(tg.xtdh_total)      AS xtdh,
        SUM(tg.xtdh_rate_daily) AS xtdh_rate
      FROM token_grants tg
      JOIN ${TDH_GRANTS_TABLE} gr
        ON gr.id = tg.grant_id
      GROUP BY gr.grantor_id
    `;

      const sql = `
        WITH token_grants AS (
          SELECT
            gts.grant_id,
            gts.xtdh_total,
            gts.xtdh_rate_daily
          FROM ${grantStatsTable} gts
          WHERE gts.\`partition\` = :partition
            AND gts.token_id      = :token_id
        ) ${selectPart}
        ORDER BY ${sort} ${order}
        LIMIT :limit OFFSET :offset
      `;

      const rows = await this.db.execute<{
        grant_id?: string;
        grantor_id?: string;
        total_grant_count: number;
        active_grant_count: number;
        xtdh: number;
        xtdh_rate: number;
      }>(
        sql,
        { partition, token_id: token, limit, offset },
        { wrappedConnection: ctx.connection }
      );

      return rows.map((it) => ({
        grant_id: it.grant_id,
        grantor_id: it.grantor_id,
        total_grant_count: Number(it.total_grant_count ?? 0),
        active_grant_count: Number(it.active_grant_count ?? 0),
        xtdh: +it.xtdh,
        xtdh_rate: +it.xtdh_rate
      }));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getTokenContributors`);
    }
  }

  async getXTdhTopGrantees(
    {
      contract,
      offset,
      limit,
      sort,
      order
    }: {
      contract: string | null;
      offset: number;
      limit: number;
      sort: 'xtdh' | 'xtdh_rate';
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<
    Array<{
      grantee_id: string;
      xtdh: number;
      xtdh_rate: number;
      collections_count: number;
      tokens_count: number;
    }>
  > {
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhTopGrantees`);

      const { tokenStatsTable } = await this.getActiveStatsTables(ctx);
      const partition = contract ? `1:${contract}` : null;

      const sql = `
      SELECT
        i.profile_id as grantee_id,
        SUM(ts.xtdh_total)      AS xtdh,
        SUM(ts.xtdh_rate_daily) AS xtdh_rate,
        COUNT(*)                AS tokens_count,
        COUNT(DISTINCT ts.\`partition\`) AS collections_count
      FROM ${tokenStatsTable} ts
      JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
        ON ack.address = ts.owner
      JOIN ${IDENTITIES_TABLE} i
        ON i.consolidation_key = ack.consolidation_key
      WHERE (:partition IS NULL OR ts.\`partition\` = :partition)
      GROUP BY i.profile_id
      ORDER BY ${sort} ${order}
      LIMIT :limit OFFSET :offset
    `;

      const rows = await this.db.execute<{
        grantee_id: string;
        xtdh: number;
        xtdh_rate: number;
        tokens_count: number;
        collections_count: number;
      }>(
        sql,
        { partition, offset, limit },
        { wrappedConnection: ctx.connection }
      );

      return rows.map((it) => ({
        grantee_id: it.grantee_id,
        xtdh: +it.xtdh,
        xtdh_rate: +it.xtdh_rate,
        collections_count: +it.collections_count,
        tokens_count: +it.tokens_count
      }));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhTopGrantees`);
    }
  }
}

export const xTdhRepository = new XTdhRepository(dbSupplier);
