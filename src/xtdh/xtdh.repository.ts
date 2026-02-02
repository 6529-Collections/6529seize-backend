import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../sql-executor';
import { RequestContext } from '../request.context';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  EXTERNAL_INDEXED_CONTRACTS_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  IDENTITIES_TABLE,
  X_TDH_COEFFICIENT,
  XTDH_GRANT_TOKENS_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_STATS_META_TABLE,
  XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX,
  XTDH_TOKEN_STATS_TABLE_PREFIX
} from '../constants';
import { Logger } from '../logging';
import { env } from '../env';
import { Time } from '../time';
import { DbPoolName } from '../db-query.options';
import {
  XTdhGrantEntity,
  XTdhGrantStatus,
  XTdhGrantTokenMode
} from '../entities/IXTdhGrant';
import { collections } from '../collections';
import { XTdhStatsMetaEntity } from '../entities/IXTdhStatsMeta';
import { NotFoundException } from '../exceptions';
import { XTdhGrantTokenEntity } from '../entities/IXTdhGrantToken';
import { numbers } from '../numbers';
import { PageSortDirection } from '../api-serverless/src/page-request';

export type GrantWithCap = XTdhGrantEntity & { grantor_x_tdh_rate: number };

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
    g.rate,
    g.valid_from,
    g.valid_to
  FROM ${XTDH_GRANTS_TABLE} g
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
    g.rate,
    g.valid_from,
    g.valid_to
  FROM ${XTDH_GRANTS_TABLE} g
  WHERE g.status = 'GRANTED'
    AND g.valid_from < (SELECT cut_ms FROM cutoff)
)`;

const CTE_INC_COUNTS = `
inc_counts AS (
  SELECT
    g.id AS grant_id,
    COUNT(*) AS inc_cnt
  FROM ${XTDH_GRANTS_TABLE} g
  JOIN ${XTDH_GRANT_TOKENS_TABLE} t
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
  WHERE gr.token_mode = '${XTdhGrantTokenMode.ALL}'

  UNION ALL

  SELECT DISTINCT
    g.id               AS grant_id,
    g.target_partition AS \`partition\`,
    t.token_id         AS token_id
  FROM ${XTDH_GRANTS_TABLE} g
  JOIN ${XTDH_GRANT_TOKENS_TABLE} t
    ON t.tokenset_id      = g.tokenset_id
   AND t.target_partition = g.target_partition
  JOIN gr ON gr.id = g.id
  WHERE gr.token_mode = '${XTdhGrantTokenMode.INCLUDE}'
)`;

const CTE_RELEVANT_TOKENS = `
relevant_tokens AS (
  SELECT DISTINCT \`partition\`, token_id
  FROM grant_tokens
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
  JOIN relevant_tokens rt
    ON rt.\`partition\` = h.\`partition\`
   AND rt.token_id     = h.token_id
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
    cm_new.ck AS new_ck,
    h.acquired_as_sale,
    h.since_time,
    h.block_number,
    h.log_index,
    LAG(h.owner) OVER (
      PARTITION BY h.\`partition\`, h.token_id
      ORDER BY h.since_time, h.block_number, h.log_index
    ) AS prev_owner,
    LAG(cm_new.ck) OVER (
      PARTITION BY h.\`partition\`, h.token_id
      ORDER BY h.since_time, h.block_number, h.log_index
    ) AS prev_ck
  FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
  JOIN relevant_tokens rt
    ON rt.\`partition\` = h.\`partition\`
   AND rt.token_id     = h.token_id
  JOIN cutoff c
    ON h.since_time <= c.cut_ms
  LEFT JOIN ck_map cm_new ON cm_new.addr = h.owner
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
   AND h.token_id     = o.token_id
   AND h.new_ck       = o.owner_ck
   AND h.since_time  <= (SELECT cut_ms FROM cutoff)
  WHERE o.rn = 1
    AND (
      h.acquired_as_sale = 1
      OR h.prev_owner IS NULL
      OR h.prev_ck IS NULL
      OR NOT (h.prev_ck <=> o.owner_ck)
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
              FROM ${XTDH_GRANTS_TABLE} g
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
              FROM ${XTDH_GRANTS_TABLE} g
              JOIN ${XTDH_GRANT_TOKENS_TABLE} t
                ON t.tokenset_id     = g.tokenset_id
               AND t.target_partition = g.target_partition
              JOIN gr ON gr.id = g.id
              WHERE gr.token_mode = '${XTdhGrantTokenMode.INCLUDE}'
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
          CTE_RELEVANT_TOKENS,
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
    gr.rate,
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
    bw.rate,
    bw.denom
  FROM bounded_windows bw
  WHERE bw.end_ms > bw.start_ms
)`,
          `
token_contrib AS (
  SELECT
    grantor_id,
    CASE WHEN denom > 0 THEN (rate / denom) * full_days ELSE 0 END AS x
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
          CTE_RELEVANT_TOKENS,
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
              gr.rate,
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
              bw.rate,
              bw.denom
            FROM bounded_windows bw
            WHERE bw.end_ms > bw.start_ms
          )
          `,
          `
          token_contrib AS (
            SELECT
              owner,
              CASE WHEN denom > 0 THEN (rate / denom) * full_days ELSE 0 END AS x
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
          CTE_RELEVANT_TOKENS,
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
    gr.rate,
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
    bw.rate,
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
             THEN (d.rate / d.denom)
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
             THEN (d.rate / d.denom)
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
                   JOIN ${XTDH_GRANTS_TABLE} tg ON tg.id = gts.grant_id
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

  public async getTotalGrantedXTdh(
    { slot }: { slot: 'a' | 'b' },
    ctx: RequestContext
  ): Promise<number> {
    const TABLE = `${XTDH_TOKEN_STATS_TABLE_PREFIX}${slot}`;
    try {
      ctx.timer?.start(`${this.constructor.name}->getTotalGrantedXTdh`);
      const result = await this.db.oneOrNull<{ total: number | string }>(
        `select floor(sum(xtdh_total)) as total from ${TABLE}`,
        {},
        { forcePool: DbPoolName.WRITE, wrappedConnection: ctx.connection }
      );
      return numbers.parseNumberOrThrow(result?.total ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getTotalGrantedXTdh`);
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

      // Clear existing stats
      await this.db.execute(`TRUNCATE TABLE ${TABLE}`, undefined, {
        wrappedConnection: ctx.connection
      });

      const sql =
        `INSERT INTO ${TABLE} (
        grant_id,
        \`partition\`,
        token_id,
        xtdh_total,
        xtdh_rate_daily
      ) ` +
        withSql(
          [
            // Shared CTEs – SAME building blocks as identity pipeline
            CTE_EPOCH,
            CTE_CUTOFF,
            CTE_GR_BASE,
            CTE_INC_COUNTS,
            CTE_GRANT_DIVISOR,
            CTE_GRANT_TOKENS,
            CTE_RELEVANT_TOKENS,
            CTE_CK_MAP,
            CTE_OWNERS_AT_CUT,
            CTE_HIST_PRE_CUT,
            CTE_LAST_RESET,

            // Ownership-aware, reset-aware bounded windows
            `
        bounded_windows AS (
          SELECT
            gto.grant_id,
            gto.\`partition\`,
            gto.token_id,
            GREATEST(
              gto.group_start_ms,
              gr.valid_from,
              (SELECT epoch_ms FROM epoch)
            ) AS start_ms,
            LEAST(
              (SELECT cut_ms FROM cutoff),
              COALESCE(gr.valid_to, (SELECT cut_ms FROM cutoff))
            ) AS end_ms,
            gr.rate,
            gd.denom,
            (SELECT cut_ms FROM cutoff) AS cut_ms
          FROM (
            SELECT
              gt.grant_id,
              gt.\`partition\`,
              gt.token_id,
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
          -- if we have no reset_since_time for this (token, owner),
          -- we treat it as having no active "run" in the current snapshot
          WHERE gto.group_start_ms IS NOT NULL
        )
        `,

            // Same day math as in identity pipeline
            `
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
            bw.rate,
            bw.denom
          FROM bounded_windows bw
          WHERE bw.end_ms > bw.start_ms
        )
        `,

            // Aggregate to per (grant, token) stats in EXACTLY the same way
            // you conceptually use for identities.
            `
        grant_token_xtdh AS (
          SELECT
            d.grant_id,
            d.\`partition\`,
            d.token_id,
            -- TOTAL xTDH for the current "run" of this token under this grant
            SUM(
              (d.rate / NULLIF(d.denom, 0)) * d.full_days
            ) AS xtdh_total,
            -- RATE for last midnight: only if matured (>= 2 days since start)
            SUM(
              CASE
                WHEN d.denom > 0 AND d.full_days > 0 AND d.days_since_start >= 2
                  THEN (d.rate / d.denom)
                ELSE 0
              END
            ) AS xtdh_rate_daily
          FROM days_owned d
          GROUP BY d.grant_id, d.\`partition\`, d.token_id
        )
        `
          ],
          `
      SELECT
        gtx.grant_id,
        gtx.\`partition\`,
        gtx.token_id,
        gtx.xtdh_total,
        gtx.xtdh_rate_daily
      FROM grant_token_xtdh gtx
      WHERE gtx.xtdh_total > 0
      `
        );

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

  private async getActiveStatsSlot(ctx: RequestContext): Promise<'a' | 'b'> {
    const meta = await this.getStatsMetaOrThrow(ctx);
    return meta.active_slot;
  }

  private async getStatsMetaOrThrow(
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

  async getXTdhCollections(
    {
      identityId,
      collectionName,
      offset,
      limit,
      sort,
      order
    }: {
      identityId: string | null;
      collectionName: string | null;
      offset: number;
      limit: number;
      sort: 'xtdh' | 'xtdh_rate';
      order: 'ASC' | 'DESC';
    },
    ctx: RequestContext
  ): Promise<
    Array<{
      contract: string;
      collection_name: string | null;
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

      const collectionNameLike = collectionName?.length
        ? `%${collectionName}%`
        : null;
      // --- FAST PATH: global leaderboard (no identity filter) ---
      if (!identityId) {
        const sql = `
        WITH
        coll_agg AS (
          SELECT
            s.\`partition\`,
            c.collection_name,
            SUM(s.xtdh_total)      AS xtdh,
            SUM(s.xtdh_rate_daily) AS xtdh_rate
          FROM ${tokenStatsTable} s
          JOIN ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c on s.\`partition\` = c.\`partition\`
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
          JOIN ${XTDH_GRANTS_TABLE} g
            ON g.id = gts.grant_id
          WHERE g.status = '${XTdhGrantStatus.GRANTED}'
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
          ca.collection_name,
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
        ${collectionNameLike ? `WHERE ca.collection_name LIKE :collectionNameLike` : ``}
        ORDER BY ${sort} ${order}
        LIMIT :limit OFFSET :offset
      `;

        const rows = await this.db.execute<{
          partition: string;
          collection_name: string | null;
          xtdh: number;
          xtdh_rate: number;
          total_token_count: number;
          active_token_count: number;
          total_contributors_count: number;
          active_contributors_count: number;
        }>(
          sql,
          { limit, offset, collectionNameLike },
          { wrappedConnection: ctx.connection }
        );

        return rows.map((it) => ({
          contract: it.partition.substring(2),
          collection_name: it.collection_name,
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
          c.collection_name,
          SUM(ts.xtdh_total)      AS xtdh,
          SUM(ts.xtdh_rate_daily) AS xtdh_rate
        FROM ts
        JOIN ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c on ts.\`partition\` = c.\`partition\`
        GROUP BY ts.\`partition\`, c.collection_name
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
        JOIN ${XTDH_GRANTS_TABLE} g
          ON g.id = gts.grant_id
        WHERE g.status = '${XTdhGrantStatus.GRANTED}'
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
        ca.collection_name,
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
      ${collectionNameLike ? `WHERE ca.collection_name LIKE :collectionNameLike` : ``}
      ORDER BY ${sort} ${order}
      LIMIT :limit OFFSET :offset
    `;

      const rows = await this.db.execute<{
        partition: string;
        collection_name: string | null;
        xtdh: number;
        xtdh_rate: number;
        total_token_count: number;
        active_token_count: number;
        total_contributors_count: number;
        active_contributors_count: number;
      }>(
        sqlWithIdentity,
        { identityId, limit, offset, collectionNameLike },
        { wrappedConnection: ctx.connection }
      );

      return rows.map((it) => ({
        contract: it.partition.substring(2),
        collection_name: it.collection_name,
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
      JOIN ${XTDH_GRANTS_TABLE} gr
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
      JOIN ${XTDH_GRANTS_TABLE} gr
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

  public async getXTdhGrantedByGrantIds(
    grantIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, number>> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhGrantedByGrantIds`);
      if (grantIds.length === 0) return {};
      const { grantStatsTable } = await this.getActiveStatsTables(ctx);
      const dbResults = await this.db.execute<{
        grant_id: string;
        total_xtdh_granted: number;
      }>(
        `
        SELECT
          grant_id,
          SUM(xtdh_total) AS total_xtdh_granted
        FROM ${grantStatsTable}
          WHERE grant_id IN (:grantIds)
        GROUP BY grant_id
      `,
        { grantIds },
        { wrappedConnection: ctx.connection }
      );
      return dbResults.reduce(
        (acc, it) => {
          acc[it.grant_id] = +it.total_xtdh_granted;
          return acc;
        },
        {} as Record<string, number>
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhGrantedByGrantIds`);
    }
  }

  async getGrantedTdhCollectionsGlobalCount(
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhCollectionsGlobalCount`
      );
      const { tokenStatsTable } = await this.getActiveStatsTables(ctx);
      const sql = `SELECT COUNT(DISTINCT s.partition) AS collections_count
        FROM ${tokenStatsTable} s
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

  async getGrantedTdhTokensGlobalCount(ctx: RequestContext): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhTokensGlobalCount`
      );
      const { tokenStatsTable } = await this.getActiveStatsTables(ctx);
      const sql = `SELECT COUNT(*) as cnt FROM ${tokenStatsTable} where xtdh_total > 0`;
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
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhTotalSumPerDayGlobal`
      );
      const { grantStatsTable } = await this.getActiveStatsTables(ctx);
      const sql = `
      SELECT COALESCE(SUM(gts.xtdh_rate_daily), 0) AS total_granted_tdh_per_day
      FROM ${grantStatsTable} gts
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
    profileId: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantedTdhCollectionsCount`
      );
      const { grantStatsTable } = await this.getActiveStatsTables(ctx);
      const lastUtcMidnightMillis = Time.latestUtcMidnight().toMillis();
      const sql = `
      SELECT COUNT(DISTINCT gts.partition) AS collections_count
      FROM ${grantStatsTable} gts
      JOIN ${XTDH_GRANTS_TABLE} g
        ON g.id = gts.grant_id
      WHERE g.grantor_id = :profile_id
        AND gts.xtdh_rate_daily > 0
    `;
      const res = await this.db.oneOrNull<{ collections_count: number }>(
        sql,
        { profile_id: profileId, lastUtcMidnightMillis },
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
    profileId: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantedTdhTokensCount`);
      const { grantStatsTable } = await this.getActiveStatsTables(ctx);
      const lastUtcMidnightMillis = Time.latestUtcMidnight().toMillis();
      const sql = `
      SELECT COUNT(DISTINCT CONCAT(gts.partition, ':', gts.token_id)) AS tokens_count
      FROM ${grantStatsTable} gts
      JOIN ${XTDH_GRANTS_TABLE} g ON g.id = gts.grant_id
      WHERE g.grantor_id = :profile_id
        AND gts.xtdh_rate_daily > 0
      `;

      const res = await this.db.oneOrNull<{ tokens_count: number }>(
        sql,
        { profile_id: profileId, lastUtcMidnightMillis },
        { wrappedConnection: ctx.connection }
      );

      return res?.tokens_count ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantedTdhTokensCount`);
    }
  }

  async getGrantedTdhTotalSumPerDay(
    profileId: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantedTdhTotalSum`);
      const { grantStatsTable } = await this.getActiveStatsTables(ctx);
      const sql = `
      SELECT COALESCE(SUM(gts.xtdh_rate_daily), 0) AS total_granted_rate
      FROM ${grantStatsTable} gts
      JOIN ${XTDH_GRANTS_TABLE} g
        ON g.id = gts.grant_id
      WHERE g.grantor_id = :profile_id
    `;
      const res = await this.db.oneOrNull<{
        total_granted_rate: number;
      }>(sql, { profile_id: profileId }, { wrappedConnection: ctx.connection });

      return res?.total_granted_rate ?? 0;
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantedTdhTotalSum`);
    }
  }

  async getIncomingXTdhRate(
    profileId: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getIncomingXTdhRate`);
      const { tokenStatsTable, grantStatsTable } =
        await this.getActiveStatsTables(ctx);
      return await this.db
        .oneOrNull<{ received_rate: number }>(
          `
          SELECT
              SUM(gts.xtdh_rate_daily) AS received_rate
          FROM ${grantStatsTable} gts
                   JOIN ${XTDH_GRANTS_TABLE} g
                        ON g.id = gts.grant_id
                   JOIN ${tokenStatsTable} ts
                        ON ts.partition = gts.partition
                            AND ts.token_id = gts.token_id
                   JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
                        ON ack.address = ts.owner
                   JOIN ${IDENTITIES_TABLE} i
                        ON i.consolidation_key = ack.consolidation_key
          WHERE i.profile_id = :profileId
      `,
          { profileId },
          { wrappedConnection: ctx.connection }
        )
        .then((it) => it?.received_rate ?? 0);
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getIncomingXTdhRate`);
    }
  }

  async getGlobalIdentityStats(ctx: RequestContext): Promise<{
    xtdh: number;
    xtdh_rate: number;
  }> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGlobalIdentityStats`);
      return this.db
        .oneOrNull<{
          xtdh: number;
          xtdh_rate: number;
        }>(
          `select sum(xtdh) as xtdh, sum(xtdh_rate) as xtdh_rate from ${IDENTITIES_TABLE}`
        )
        .then((it) => it ?? { xtdh: 0, xtdh_rate: 0 });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGlobalIdentityStats`);
    }
  }

  async getGrantedXTdhRateGlobal(ctx: RequestContext) {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getXTdhGrantedLastMidnightGlobal`
      );
      const { grantStatsTable } = await this.getActiveStatsTables(ctx);
      const res = await this.db.oneOrNull<{
        total_xtdh_granted_last_midnight: number;
      }>(
        `
          SELECT
            COALESCE(SUM(gts.xtdh_rate_daily), 0) AS total_xtdh_granted_last_midnight
          FROM ${grantStatsTable} gts
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

  public async lockOldestPendingGrant(
    ctx: RequestContext
  ): Promise<(XTdhGrantEntity & { tokens: string[] }) | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->lockOldestPendingGrant`);
      const connection = ctx.connection;
      if (!connection) {
        throw new Error(`Can not acquire db locks without a transaction`);
      }
      const grant = await this.db.oneOrNull<XTdhGrantEntity>(
        `
      select * from ${XTDH_GRANTS_TABLE} where status = '${XTdhGrantStatus.PENDING}' order by updated_at limit 1 for update skip locked
    `,
        undefined,
        { wrappedConnection: connection }
      );
      if (!grant) {
        return null;
      }
      const now = Time.currentMillis();
      await this.db.execute(
        `update ${XTDH_GRANTS_TABLE} set updated_at = :now where id = :grant_id`,
        { now, grant_id: grant.id },
        { wrappedConnection: connection }
      );
      const tokens: string[] = [];
      if (grant.tokenset_id) {
        await this.db
          .execute<{
            token_id: string;
          }>(
            `select token_id from ${XTDH_GRANT_TOKENS_TABLE} where tokenset_id = :tokenset_id`,
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

  public async getGrantById(
    id: string,
    ctx: RequestContext
  ): Promise<XTdhGrantEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantById`);
      return await this.db.oneOrNull<XTdhGrantEntity>(
        `
      select * from ${XTDH_GRANTS_TABLE} where id = :id
    `,
        { id },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantById`);
    }
  }

  public async lockGrantById(
    id: string,
    ctx: RequestContext
  ): Promise<XTdhGrantEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->lockGrantById`);
      const connection = ctx.connection;
      if (!connection) {
        throw new Error(`Can not acquire db locks without a transaction`);
      }
      return await this.db.oneOrNull<XTdhGrantEntity>(
        `
      select * from ${XTDH_GRANTS_TABLE} where id = :id for update
    `,
        { id },
        { wrappedConnection: connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->lockOldestPendingGrant`);
    }
  }

  public async insertGrant(
    tdhGrantEntity: XTdhGrantEntity,
    tokens: XTdhGrantTokenEntity[],
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->insertGrant`);
    await this.db.execute(
      `
      insert into ${XTDH_GRANTS_TABLE}
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
       rate,
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
       :rate,
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
    await this.db.bulkInsert(
      XTDH_GRANT_TOKENS_TABLE,
      tokens,
      ['tokenset_id', 'token_id', 'target_partition'],
      ctx
    );
    ctx.timer?.stop(`${this.constructor.name}->insertGrant`);
  }

  public async getPageItems(
    {
      grantor_id,
      target_contracts,
      target_chain,
      valid_from_lt,
      valid_from_gt,
      valid_to_lt,
      valid_to_gt,
      status,
      sort_direction,
      sort,
      limit,
      offset
    }: {
      readonly grantor_id: string | null;
      readonly target_contracts: string[];
      readonly target_chain: number | null;
      readonly valid_from_lt: number | null;
      readonly valid_from_gt: number | null;
      readonly valid_to_lt: number | null;
      readonly valid_to_gt: number | null;
      readonly status: XTdhGrantStatus[];
      readonly sort_direction: 'ASC' | 'DESC' | null;
      readonly sort: 'created_at' | 'valid_from' | 'valid_to' | 'rate' | null;
      readonly limit: number;
      readonly offset: number;
    },
    ctx: RequestContext
  ): Promise<XTdhGrantEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getPageItems`);
      const select = `SELECT t.* FROM ${XTDH_GRANTS_TABLE} t`;
      const { whereAnds, params } = this.getSearchWhereAnds(
        grantor_id,
        target_contracts,
        target_chain,
        status,
        valid_from_lt,
        valid_from_gt,
        valid_to_lt,
        valid_to_gt
      );
      const ordering = `order by t.${sort ?? 'created_at'} ${sort_direction ?? ''} limit :limit offset :offset`;
      params.limit = limit;
      params.offset = offset;
      const sql = `${select} ${whereAnds.length ? ` where ` : ``} ${whereAnds.join(' and ')} ${ordering}`;
      return await this.db.execute<XTdhGrantEntity>(sql, params, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getPageItems`);
    }
  }

  public async countItems(
    {
      grantor_id,
      target_contracts,
      target_chain,
      status,
      valid_from_lt,
      valid_from_gt,
      valid_to_lt,
      valid_to_gt
    }: {
      readonly grantor_id: string | null;
      readonly target_contracts: string[];
      readonly target_chain: number | null;
      readonly valid_from_lt: number | null;
      readonly valid_from_gt: number | null;
      readonly valid_to_lt: number | null;
      readonly valid_to_gt: number | null;
      readonly status: XTdhGrantStatus[];
    },
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(`${this.constructor.name}->countItems`);
      const select = `SELECT count(*) as cnt FROM ${XTDH_GRANTS_TABLE} t`;
      const { whereAnds, params } = this.getSearchWhereAnds(
        grantor_id,
        target_contracts,
        target_chain,
        status,
        valid_from_lt,
        valid_from_gt,
        valid_to_lt,
        valid_to_gt
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
    target_contracts: string[],
    target_chain: number | null,
    status: XTdhGrantStatus[],
    valid_from_lt: number | null,
    valid_from_gt: number | null,
    valid_to_lt: number | null,
    valid_to_gt: number | null
  ) {
    const whereAnds: string[] = [];
    const params: Record<string, any> = {};
    if (grantor_id) {
      whereAnds.push(`t.grantor_id = :grantor_id`);
      params['grantor_id'] = grantor_id;
    }
    if (target_contracts.length) {
      whereAnds.push(`t.target_contract in (:target_contracts)`);
      params['target_contracts'] = target_contracts;
    }
    if (target_chain) {
      whereAnds.push(`t.target_chain = :target_chain`);
      params['target_chain'] = target_chain;
    }
    if (status.length) {
      whereAnds.push(`t.status in (:status)`);
      params['status'] = status;
    }
    if (valid_from_lt !== null) {
      whereAnds.push(`t.valid_from < :valid_from_lt`);
      params['valid_from_lt'] = valid_from_lt;
    }
    if (valid_from_gt !== null) {
      whereAnds.push(`t.valid_from > :valid_from_gt`);
      params['valid_from_gt'] = valid_from_gt;
    }
    if (valid_to_lt !== null) {
      whereAnds.push(`(t.valid_to is not null and t.valid_to < :valid_to_lt)`);
      params['valid_to_lt'] = valid_to_lt;
    }
    if (valid_to_gt !== null) {
      whereAnds.push(`(t.valid_to is null or t.valid_to > :valid_to_gt)`);
      params['valid_to_gt'] = valid_to_gt;
    }
    return { whereAnds, params };
  }

  async updateStatus(
    param: {
      grantId: string;
      status: XTdhGrantStatus;
      error: string | null;
      validFrom?: number;
    },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->updateStatus`);
    this.logger.info(`Updating grant status`, param);
    try {
      await this.db.execute(
        `update ${XTDH_GRANTS_TABLE}
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
                SELECT COALESCE(SUM(g.rate), 0) AS base_rate
                FROM ${XTDH_GRANTS_TABLE} g
                WHERE g.grantor_id = :grantorId
                  AND g.status = '${XTdhGrantStatus.GRANTED}'
                  AND g.valid_from <= :validFrom
                  AND (g.valid_to IS NULL OR g.valid_to > :validFrom)
              ),
              edges AS (
                -- +rate at starts strictly inside the window
                SELECT g.valid_from AS ts, g.rate AS delta
                FROM ${XTDH_GRANTS_TABLE} g
                WHERE g.grantor_id = :grantorId
                  AND g.status = '${XTdhGrantStatus.GRANTED}'
                  AND g.valid_from > :validFrom
                  AND g.valid_from < :validTo
                  AND (g.valid_to IS NULL OR g.valid_to > :validFrom)

                UNION ALL

                -- -rate at ends inside the window
                SELECT g.valid_to AS ts, -g.rate AS delta
                FROM ${XTDH_GRANTS_TABLE} g
                WHERE g.grantor_id = :grantorId
                  AND g.status = '${XTdhGrantStatus.GRANTED}'
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

  async getGrantorsLooseSpentTdhRate(
    grantorId: string,
    ctx: RequestContext
  ): Promise<number> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getGrantorsLooseSpentTdhRate`
      );
      return this.db
        .oneOrNull<{ spent_rate: number }>(
          `
            SELECT sum(rate) as spent_rate from ${XTDH_GRANTS_TABLE} g where g.grantor_id = :grantorId and g.status in (:statuses) and (valid_to is null or valid_to > :now)
        `,
          {
            grantorId,
            statuses: [XTdhGrantStatus.GRANTED, XTdhGrantStatus.PENDING],
            now: Time.currentMillis()
          },
          {
            wrappedConnection: ctx.connection
          }
        )
        ?.then((res) => +(res?.spent_rate ?? 0));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantorsLooseSpentTdhRate`);
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
                FROM ${XTDH_GRANTS_TABLE}
                WHERE status = '${XTdhGrantStatus.GRANTED}'
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
                  COALESCE(SUM(rate), 0) AS delta
                FROM gr
                WHERE valid_from <= :windowStart
                  AND (valid_to   IS NULL OR valid_to   >  :windowStart)
                GROUP BY grantor_id
              ),

              edges AS (
                SELECT grantor_id, valid_from AS ts,  rate AS delta
                FROM gr
                WHERE valid_from IS NOT NULL
                  AND valid_from > :windowStart AND valid_from < :windowEnd
                UNION ALL
                SELECT grantor_id, valid_to   AS ts, -rate AS delta
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
    param: { ids: string[]; status: XTdhGrantStatus; error: string | null },
    ctx: RequestContext
  ) {
    ctx.timer?.start(`${this.constructor.name}->updateStatus`);
    try {
      if (param.ids.length) {
        await this.db.execute(
          `update ${XTDH_GRANTS_TABLE}
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

  async bulkInsert(entities: XTdhGrantEntity[], ctx: RequestContext) {
    await this.db.bulkInsert(
      XTDH_GRANTS_TABLE,
      entities,
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
        'rate',
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
                          FROM ${XTDH_GRANT_TOKENS_TABLE} t
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
              FROM ${XTDH_GRANTS_TABLE} g
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
  ): Promise<{ token: string; xtdh: number }[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantTokensPage`);

      const { grant_id, sort_direction, limit, offset } = param;
      const grant = await this.db.oneOrNull<{
        token_mode: XTdhGrantTokenMode;
        target_partition: string;
        tokenset_id: string | null;
      }>(
        `
        SELECT token_mode, target_partition, tokenset_id
        FROM ${XTDH_GRANTS_TABLE}
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
        offset,
        grant_id
      };

      const { grantStatsTable } = await this.getActiveStatsTables(ctx);

      if (grant.token_mode === XTdhGrantTokenMode.ALL) {
        sql = `
        with token_numbers as (
            SELECT DISTINCT h.token_id AS token
                                   FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
                                   WHERE h.\`partition\` = :partition
                                   ORDER BY h.token_id ${direction}
            LIMIT :limit OFFSET :offset 
        ) select t.token as token, ifnull(x.xtdh_total, 0) as xtdh from token_numbers t left join ${grantStatsTable} x on t.token = x.token_id and x.grant_id = :grant_id ORDER BY t.token ${direction}
      `;
        params.partition = grant.target_partition;
      } else if (
        grant.token_mode === XTdhGrantTokenMode.INCLUDE &&
        grant.tokenset_id
      ) {
        sql = `
        with token_numbers as (
            SELECT DISTINCT t.token_id AS token
                               FROM ${XTDH_GRANT_TOKENS_TABLE} t
                               WHERE t.tokenset_id = :tokenset_id
                                 AND t.target_partition = :partition
                                 AND EXISTS (SELECT 1
                                             FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
                                             WHERE h.\`partition\` = t.target_partition
                                               AND h.token_id = t.token_id)
                               ORDER BY t.token_id ${direction}
            LIMIT :limit OFFSET :offset 
        ) select t.token as token, ifnull(x.xtdh_total, 0) as xtdh from token_numbers t left join ${grantStatsTable} x on t.token = x.token_id and x.grant_id = :grant_id ORDER BY t.token ${direction}
      `;
        params.tokenset_id = grant.tokenset_id;
        params.partition = grant.target_partition;
      } else {
        return [];
      }

      const rows = await this.db.execute<{ token: number; xtdh: number }>(
        sql,
        params,
        {
          wrappedConnection: ctx.connection
        }
      );

      return rows.map((r) => ({ token: String(r.token), xtdh: r.xtdh }));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantTokensPage`);
    }
  }

  public async getGrantsByIds(
    grantIds: string[],
    ctx: RequestContext
  ): Promise<XTdhGrantEntity[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getGrantsByIds`);
      if (!grantIds.length) {
        return [];
      }
      return this.db.execute<XTdhGrantEntity>(
        `select * from ${XTDH_GRANTS_TABLE} where id in (:grantIds)`,
        { grantIds },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getGrantsByIds`);
    }
  }

  async getCollectionNames(
    grantIds: string[],
    ctx: RequestContext
  ): Promise<Record<string, string>> {
    if (!grantIds.length) {
      return {};
    }
    const dbResults = await this.db.execute<{
      collection_name: string;
      grant_id: string;
    }>(
      `select g.id as grant_id, c.collection_name from ${XTDH_GRANTS_TABLE} g join ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c on c.partition = g.target_partition where g.id in (:grantIds)`,
      { grantIds },
      { wrappedConnection: ctx.connection }
    );
    return dbResults.reduce(
      (acc, it) => {
        acc[it.grant_id] = it.collection_name;
        return acc;
      },
      {} as Record<string, string>
    );
  }

  async getContractsOfExternalAddressesWhereNameLike(
    name: string,
    ctx: RequestContext
  ): Promise<string[]> {
    if (!name.length) {
      return [];
    }
    const dbResults = await this.db.execute<{
      partition: string;
    }>(
      `select distinct c.partition from ${XTDH_GRANTS_TABLE} g join ${EXTERNAL_INDEXED_CONTRACTS_TABLE} c on c.partition = g.target_partition where c.collection_name like :cName`,
      { cName: `%${name}%` },
      { wrappedConnection: ctx.connection }
    );
    return collections.distinct(
      dbResults.map((it) => it.partition.substring(2))
    );
  }

  async migrateGrantorId(
    source: string,
    target: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.db.execute(
      `
        update ${XTDH_GRANTS_TABLE} set grantor_id = :target where grantor_id = :source
      `,
      { source, target },
      { wrappedConnection: connectionHolder.connection }
    );
  }
}

export const xTdhRepository = new XTdhRepository(dbSupplier);
