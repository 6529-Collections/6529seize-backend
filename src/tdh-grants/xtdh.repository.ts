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
  X_TDH_COEFFICIENT
} from '../constants';
import { Logger } from '../logging';
import { env } from '../env';
import { Time } from '../time';
import { TdhGrantTokenMode } from '../entities/ITdhGrant';

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

      return await this.db
        .execute<{
          wallet: string;
        }>(sql, undefined, { wrappedConnection: ctx.connection })
        .then((res) => res.map((it) => it.wallet));
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getWalletsWithoutIdentities`);
    }
  }

  async deleteXTdhState(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->deleteXTdhState`);
      await this.db.execute(
        `UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} SET xtdh = 0`,
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
      this.logger.info(
        `Clearing produced xTDH in ${CONSOLIDATED_WALLETS_TDH_TABLE}`
      );
      await this.db.execute(
        `
        UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE}
        SET produced_xtdh = 0
        WHERE produced_xtdh <> 0
      `,
        undefined,
        { wrappedConnection: ctx.connection }
      );
      this.logger.info(
        `Setting produced xTDH in ${CONSOLIDATED_WALLETS_TDH_TABLE}`
      );
      await this.db.execute(
        `
          UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} c
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
    `,
        { days_since_epoch: this.getDaysSinceXTdhEpoch() },
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateProducedXTDH`);
    }
  }

  async updateAllGrantedXTdhsOnConsolidated(ctx: RequestContext) {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->updateAllGrantedXTdhsOnConsolidated`
      );

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
          UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} cw
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
        UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} cw
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
        `UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} SET xtdh = xtdh + (produced_xtdh - granted_xtdh)`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->updateAllXTdhsWithGrantedPart`
      );
    }
  }

  async updateTotalTdhs(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateTotalTdhs`);
      await this.db.execute(
        `UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} SET total_tdh = xtdh + (produced_xtdh - granted_xtdh) + boosted_tdh`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateTotalTdhs`);
    }
  }
}

export const xTdhRepository = new XTdhRepository(dbSupplier);
