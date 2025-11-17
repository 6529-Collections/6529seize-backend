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
  XTDH_TOKEN_GRANT_STATS_TABLE_PREFIX
} from '../constants';
import { Logger } from '../logging';
import { env } from '../env';
import { Time } from '../time';
import { TdhGrantStatus, TdhGrantTokenMode } from '../entities/ITdhGrant';
import { redisCached } from '../redis';
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
        `UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} SET xtdh = 0, xtdh_rate = 0`,
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
      const sql = `
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

  async updateBoostedTdhRate(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateBoostedTdhRate`);
      const sql = `
      UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} cw
      LEFT JOIN (
        SELECT
          c.consolidation_key,
          SUM(e.hodl_rate) * COALESCE(MAX(c.boost), 1.0) AS boosted_tdh_rate
        FROM ${CONSOLIDATED_WALLETS_TDH_TABLE} c
        LEFT JOIN ${CONSOLIDATED_TDH_EDITIONS_TABLE} e
          ON e.consolidation_key = c.consolidation_key
        GROUP BY c.consolidation_key
      ) x
        ON x.consolidation_key = cw.consolidation_key
      SET cw.boosted_tdh_rate = COALESCE(x.boosted_tdh_rate, 0)
    `;
      await this.db.execute(sql, undefined, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateBoostedTdhRate`);
    }
  }

  async updateTotalTdhs(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateTotalTdhs`);
      await this.db.execute(
        `UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} SET total_tdh = xtdh + boosted_tdh`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateTotalTdhs`);
    }
  }

  async createMissingTdhConsolidations(ctx: RequestContext) {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->createMissingTdhConsolidations`
      );
      await this.db.execute(
        `
              INSERT INTO ${CONSOLIDATED_WALLETS_TDH_TABLE} (
                  \`date\`,
                  consolidation_display,
                  wallets,
                  \`block\`,
                  boost,
                  tdh_rank,
                  tdh_rank_memes,
                  tdh_rank_gradients,
                  balance,
                  genesis,
                  memes_cards_sets,
                  unique_memes,
                  memes_balance,
                  memes,
                  memes_ranks,
                  gradients_balance,
                  gradients,
                  gradients_ranks,
                  consolidation_key,
                  tdh_rank_nextgen,
                  nextgen_balance,
                  nextgen,
                  nextgen_ranks,
                  boost_breakdown,
                  nakamoto,
                  tdh,
                  boosted_tdh,
                  tdh__raw,
                  boosted_memes_tdh,
                  memes_tdh,
                  memes_tdh__raw,
                  boosted_gradients_tdh,
                  gradients_tdh,
                  gradients_tdh__raw,
                  boosted_nextgen_tdh,
                  nextgen_tdh,
                  nextgen_tdh__raw,
                  produced_xtdh,
                  xtdh,
                  total_tdh,
                  granted_xtdh
              )
              WITH
                  cutoff AS (
                      SELECT UNIX_TIMESTAMP(DATE(UTC_TIMESTAMP())) * 1000 AS cut_ms
                  ),
                  gr AS (
                      SELECT g.id, g.target_partition, g.token_mode, g.tokenset_id
                      FROM ${TDH_GRANTS_TABLE} g
                      WHERE g.status = '${TdhGrantStatus.GRANTED}'
                  ),
                  grant_tokens AS (
                      SELECT gr.id AS grant_id, gr.target_partition AS \`partition\`, h.token_id
                      FROM gr
                               JOIN  ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
                                    ON h.\`partition\` = gr.target_partition
                      WHERE gr.token_mode = '${TdhGrantTokenMode.ALL}'
                      GROUP BY gr.id, gr.target_partition, h.token_id
              
                      UNION ALL
              
                      SELECT gr.id AS grant_id, t.target_partition AS \`partition\`, t.token_id
                      FROM gr
                               JOIN  ${TDH_GRANT_TOKENS_TABLE} t
                                    ON t.tokenset_id = gr.tokenset_id
                                        AND t.target_partition = gr.target_partition
                      WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
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
                      FROM  ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
                               CROSS JOIN cutoff c
                               JOIN grant_tokens gt
                                    ON gt.\`partition\` = h.\`partition\`
                                        AND gt.token_id    = h.token_id
                      WHERE h.since_time < c.cut_ms
                  ),
                  candidates AS (
                      SELECT DISTINCT ack.consolidation_key
                      FROM owners_at_cut o
                               JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
                                    ON ack.address = o.owner
                               LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} tc
                                         ON tc.consolidation_key = ack.consolidation_key
                      WHERE o.rn = 1
                        AND tc.consolidation_key IS NULL
                  ),
                  max_block AS (
                      SELECT COALESCE(MAX(\`block\`), 0) AS blk, UTC_TIMESTAMP() AS dt
                      FROM tdh_consolidation
                  )
              SELECT *
              FROM (
                       SELECT
                           mb.dt AS \`date\`,
                           c.consolidation_key AS consolidation_display,
                           JSON_ARRAY(c.consolidation_key) AS wallets,
                           mb.blk AS \`block\`,
                           0 AS boost,
                           0 AS tdh_rank,
                           0 AS tdh_rank_memes,
                           0 AS tdh_rank_gradients,
                           0 AS balance,
                           0 AS genesis,
                           0 AS memes_cards_sets,
                           0 AS unique_memes,
                           0 AS memes_balance,
                           NULL AS memes,
                           NULL AS memes_ranks,
                           0 AS gradients_balance,
                           NULL AS gradients,
                           NULL AS gradients_ranks,
                           c.consolidation_key AS consolidation_key,
                           0 AS tdh_rank_nextgen,
                           0 AS nextgen_balance,
                           NULL AS nextgen,
                           NULL AS nextgen_ranks,
                           NULL AS boost_breakdown,
                           0 AS nakamoto,
                           0 AS tdh,
                           0 AS boosted_tdh,
                           0 AS tdh__raw,
                           0 AS boosted_memes_tdh,
                           0 AS memes_tdh,
                           0 AS memes_tdh__raw,
                           0 AS boosted_gradients_tdh,
                           0 AS gradients_tdh,
                           0 AS gradients_tdh__raw,
                           0 AS boosted_nextgen_tdh,
                           0 AS nextgen_tdh,
                           0 AS nextgen_tdh__raw,
                           0 AS produced_xtdh,
                           0 AS xtdh,
                           0 AS total_tdh,
                           0 AS granted_xtdh
                       FROM candidates c
                                CROSS JOIN max_block mb
                   ) AS new_rows
              ON DUPLICATE KEY UPDATE
                  consolidation_key = new_rows.consolidation_key
      `,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->createMissingTdhConsolidations`
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
UPDATE ${CONSOLIDATED_WALLETS_TDH_TABLE} cw
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

  async getXTdhTokens(
    filters: {
      identityId?: string | null;
      collection?: string | null;
      token?: string | null;
      offset?: number | null;
      limit?: number | null;
    },
    ctx: RequestContext
  ): Promise<
    Array<{ contract: string; token: string; xtdh: number; xtdh_rate: number }>
  > {
    const {
      identityId = null,
      collection = null,
      token = null,
      offset = 0,
      limit = 100
    } = filters ?? {};
    const partition = collection ? `1:${collection}` : null;
    if (token && !partition) {
      return [];
    }
    try {
      ctx.timer?.start(`${this.constructor.name}->getXTdhTokens`);
      const params: Record<string, unknown> = {
        identityId,
        partition,
        token, // pass token as string; we CAST history/grant side to CHAR
        x_tdh_epoch_ms: this.getXTdhEpochMillis(),
        offset,
        limit
      };

      const sql = `
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
        SELECT id, target_partition, token_mode, tdh_rate, valid_from, valid_to
        FROM ${TDH_GRANTS_TABLE}
        WHERE status = 'GRANTED'
      ),
      -- include-counts only for INCLUDE grants
      inc_counts AS (
        SELECT g.id AS grant_id, COUNT(*) AS inc_cnt
        FROM ${TDH_GRANTS_TABLE} g
        JOIN ${TDH_GRANT_TOKENS_TABLE} t
          ON t.tokenset_id      = g.tokenset_id
         AND t.target_partition = g.target_partition
        WHERE g.status = 'GRANTED' AND g.token_mode = 'INCLUDE'
        GROUP BY g.id
      ),
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
        LEFT JOIN inc_counts ic ON ic.grant_id = gr.id
      ),
      -- universe of targeted (contract, token) pairs
      grant_tokens AS (
        SELECT DISTINCT
          gr.id               AS grant_id,
          gr.target_partition AS \`partition\`,
          CAST(h.token_id AS CHAR) AS token_id
        FROM gr
        JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
          ON h.\`partition\` = gr.target_partition
        WHERE gr.token_mode = 'ALL'

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
        WHERE gr.token_mode = 'INCLUDE'
      ),
      -- at-cutoff owners for optional grantee (identity) filter
      owners_at_cut AS (
        SELECT
          h.\`partition\`,
          CAST(h.token_id AS CHAR) AS token_id,
          h.owner,
          ROW_NUMBER() OVER (
            PARTITION BY h.\`partition\`, h.token_id
            ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
          ) AS rn
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        JOIN cutoff c
          ON h.since_time < c.cut_ms
      ),
      -- optionally restrict tokens to those owned by the identity at cutoff
      eligible_tokens AS (
        SELECT gt.\`partition\`, gt.token_id
        FROM grant_tokens gt
        -- collection / token filters
        WHERE (:partition IS NULL OR gt.\`partition\` = :partition)
          AND (:token      IS NULL OR gt.token_id     = CAST(:token AS CHAR))

        INTERSECT
        -- if identityId provided, keep only tokens owned by that identity at cutoff
        SELECT o.\`partition\`, o.token_id
        FROM owners_at_cut o
        JOIN ${ADDRESS_CONSOLIDATION_KEY} ack
          ON ack.address = o.owner
        JOIN ${IDENTITIES_TABLE} i
          ON i.consolidation_key = ack.consolidation_key
        WHERE o.rn = 1
          AND (:identityId IS NULL OR i.profile_id = :identityId)
      ),
      bounded_windows AS (
        SELECT
          gt.grant_id,
          gt.\`partition\`,
          gt.token_id,
          GREATEST(gr.valid_from, (SELECT epoch_ms FROM epoch)) AS start_ms,
          LEAST(COALESCE(gr.valid_to, (SELECT cut_ms FROM cutoff)),
                (SELECT cut_ms FROM cutoff)) AS end_ms,
          gr.tdh_rate,
          gd.denom,
          (SELECT cut_ms FROM cutoff) AS cut_ms
        FROM grant_tokens gt
        JOIN eligible_tokens et
          ON et.\`partition\` = gt.\`partition\`
         AND et.token_id     = gt.token_id
        JOIN gr  ON gr.id = gt.grant_id
        JOIN grant_divisor gd ON gd.id = gr.id
      ),
      days_owned AS (
        SELECT
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
      token_xtdh AS (
        SELECT
      d.\`partition\`,
          d.token_id,
          SUM( (d.tdh_rate / NULLIF(d.denom, 0)) * d.full_days ) AS raw_xtdh,
          SUM(
            CASE
              WHEN d.denom > 0 AND d.full_days > 0 AND d.days_since_start >= 2
              THEN (d.tdh_rate / d.denom)
              ELSE 0
            END
          ) AS raw_xtdh_rate
        FROM days_owned d
        GROUP BY d.\`partition\`, d.token_id
      )
      SELECT
        tx.\`partition\` AS contract,
        tx.token_id      AS token,
        tx.raw_xtdh      * ${X_TDH_COEFFICIENT} AS xtdh,
        tx.raw_xtdh_rate * ${X_TDH_COEFFICIENT} AS xtdh_rate
      FROM token_xtdh tx
      WHERE tx.raw_xtdh > 0
      ORDER BY xtdh DESC limit :limit offset :offset
    `;

      return await redisCached(
        `${this.constructor.name}->getXTdhTokens({identityId:${filters.identityId},collection:${filters.collection},token:${filters.token},offset:${filters.offset},limit:${filters.limit})`,
        Time.minutes(2),
        async () => {
          const rows = await this.db.execute<{
            contract: string;
            token: string;
            xtdh: number;
            xtdh_rate: number;
          }>(sql, params, { wrappedConnection: ctx.connection });

          return rows.map((it) => ({
            ...it,
            contract: it.contract.substring(2)
          }));
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getXTdhTokens`);
    }
  }

  async getTokenGrantors(
    param: { contract: string; token: string },
    ctx: RequestContext
  ): Promise<Array<{ profile_id: string; xtdh: number; xtdh_rate: number }>> {
    const { contract, token } = param;
    try {
      ctx.timer?.start(`${this.constructor.name}->getTokenGrantors`);
      const sql = `
      WITH
        epoch AS (
          SELECT :x_tdh_epoch_ms AS epoch_ms
        ),
        cutoff AS (
          SELECT UNIX_TIMESTAMP(DATE(UTC_TIMESTAMP())) * 1000 AS cut_ms
        ),
        gr AS (
          SELECT id, grantor_id, target_partition, token_mode, tdh_rate, valid_from, valid_to
          FROM tdh_grants
          WHERE status = 'GRANTED'
        ),
        inc_counts AS (
          SELECT g.id AS grant_id, COUNT(*) AS inc_cnt
          FROM tdh_grants g
          JOIN tdh_grant_tokens t
            ON t.tokenset_id      = g.tokenset_id
           AND t.target_partition = g.target_partition
          WHERE g.status = 'GRANTED' AND g.token_mode = 'INCLUDE'
          GROUP BY g.id
        ),
        grant_divisor AS (
          SELECT
            gr.id,
            CASE
              WHEN gr.token_mode = 'ALL' THEN COALESCE(c.total_supply, 0)
              ELSE COALESCE(ic.inc_cnt, 0)
            END AS denom
          FROM gr
          LEFT JOIN external_indexed_contracts c
            ON c.\`partition\` = gr.target_partition
          LEFT JOIN inc_counts ic ON ic.grant_id = gr.id
        ),
        grant_tokens AS (
          SELECT DISTINCT
            gr.id               AS grant_id,
            gr.target_partition AS \`partition\`,
            CAST(h.token_id AS CHAR) COLLATE utf8mb4_general_ci AS token_id
          FROM gr
          JOIN external_indexed_ownership_721_histories h
            ON h.\`partition\` = gr.target_partition
          WHERE gr.token_mode = 'ALL'
      
          UNION ALL
      
          SELECT DISTINCT
            g.id               AS grant_id,
            g.target_partition AS \`partition\`,
            CAST(t.token_id AS CHAR) COLLATE utf8mb4_general_ci AS token_id
          FROM tdh_grants g
          JOIN tdh_grant_tokens t
            ON t.tokenset_id      = g.tokenset_id
           AND t.target_partition = g.target_partition
          JOIN gr ON gr.id = g.id
          WHERE gr.token_mode = 'INCLUDE'
        ),
        target_rows AS (
          SELECT gt.grant_id, gt.\`partition\`, gt.token_id
          FROM grant_tokens gt
          WHERE gt.\`partition\` COLLATE utf8mb4_general_ci = CAST(:partition AS CHAR) COLLATE utf8mb4_general_ci
            AND gt.token_id  COLLATE utf8mb4_general_ci   = CAST(:token     AS CHAR) COLLATE utf8mb4_general_ci
        ),
        bounded_windows AS (
          SELECT
            tr.grant_id,
            gr.grantor_id,
            tr.\`partition\`,
            tr.token_id,
            GREATEST(gr.valid_from, (SELECT epoch_ms FROM epoch)) AS start_ms,
            LEAST(COALESCE(gr.valid_to, (SELECT cut_ms FROM cutoff)),
                  (SELECT cut_ms FROM cutoff)) AS end_ms,
            gr.tdh_rate,
            gd.denom,
            (SELECT cut_ms FROM cutoff) AS cut_ms
          FROM target_rows tr
          JOIN gr  ON gr.id = tr.grant_id
          JOIN grant_divisor gd ON gd.id = gr.id
        ),
        days_owned AS (
          SELECT
            bw.grantor_id,
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
        grantor_totals AS (
          SELECT
            d.grantor_id AS profile_id,
            SUM( (d.tdh_rate / NULLIF(d.denom, 0)) * d.full_days ) AS raw_xtdh,
            SUM(
              CASE
                WHEN d.denom > 0 AND d.full_days > 0 AND d.days_since_start >= 2
                THEN (d.tdh_rate / d.denom)
                ELSE 0
              END
            ) AS raw_xtdh_rate
          FROM days_owned d
          GROUP BY d.grantor_id
        )
      SELECT
        gt.profile_id,
        gt.raw_xtdh      * 0.1 AS xtdh,
        gt.raw_xtdh_rate * 0.1 AS xtdh_rate
      FROM grantor_totals gt
      WHERE gt.raw_xtdh > 0
      ORDER BY xtdh DESC;
    `;
      return await redisCached(
        `${this.constructor.name}->getTokenGrantors({contract:${contract},token:${token}})`,
        Time.minutes(2),
        async () => {
          return await this.db.execute<{
            profile_id: string;
            xtdh: number;
            xtdh_rate: number;
          }>(
            sql,
            {
              partition: `1:${contract}`,
              token,
              x_tdh_epoch_ms: this.getXTdhEpochMillis()
            },
            { wrappedConnection: ctx.connection }
          );
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getTokenGrantors`);
    }
  }

  async getReceivedContractsByIdentity(
    profileId: string,
    ctx: RequestContext
  ): Promise<string[]> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getReceivedContractsByIdentity`
      );
      const sql = `
      WITH
      epoch AS (
        SELECT :x_tdh_epoch_ms AS epoch_ms
      ),
      cutoff AS (
        SELECT UNIX_TIMESTAMP(DATE(UTC_TIMESTAMP())) * 1000 AS cut_ms
      ),
      -- target identity's consolidation key
      target_ck AS (
        SELECT i.consolidation_key AS ck
        FROM ${IDENTITIES_TABLE} i
        WHERE i.profile_id = :profile_id
        LIMIT 1
      ),
      -- map addresses -> consolidation keys
      ck_map AS (
        SELECT ack.address AS addr, ack.consolidation_key AS ck
        FROM ${ADDRESS_CONSOLIDATION_KEY} ack
      ),

      -- GRANTED grants universe
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
      ),
      -- denom for INCLUDE mode
      inc_counts AS (
        SELECT g.id AS grant_id, COUNT(*) AS inc_cnt
        FROM ${TDH_GRANTS_TABLE} g
        JOIN ${TDH_GRANT_TOKENS_TABLE} t
          ON t.tokenset_id      = g.tokenset_id
         AND t.target_partition = g.target_partition
        WHERE g.status = 'GRANTED'
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
      -- tokens targeted by grants (normalize token_id to CHAR for joins)
      grant_tokens AS (
        SELECT DISTINCT
          gr.id               AS grant_id,
          gr.target_partition AS \`partition\`,
          CAST(h.token_id AS CHAR) COLLATE utf8mb4_general_ci AS token_id
        FROM gr
        JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
          ON h.\`partition\` = gr.target_partition
        WHERE gr.token_mode = '${TdhGrantTokenMode.ALL}'

        UNION ALL

        SELECT DISTINCT
          g.id               AS grant_id,
          g.target_partition AS \`partition\`,
          CAST(t.token_id AS CHAR) COLLATE utf8mb4_general_ci AS token_id
        FROM ${TDH_GRANTS_TABLE} g
        JOIN ${TDH_GRANT_TOKENS_TABLE} t
          ON t.tokenset_id      = g.tokenset_id
         AND t.target_partition = g.target_partition
        JOIN gr ON gr.id = g.id
        WHERE gr.token_mode = '${TdhGrantTokenMode.INCLUDE}'
      ),

      -- owners at last midnight + owner CK (we'll filter to our CK)
      owners_at_cut AS (
        SELECT
          h.\`partition\`,
          h.token_id,
          h.owner,
          cm.ck AS owner_ck,
          ROW_NUMBER() OVER (
            PARTITION BY h.\`partition\`, h.token_id
            ORDER BY h.since_time DESC, h.block_number DESC, h.log_index DESC
          ) AS rn
        FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
        JOIN cutoff c
          ON h.since_time < c.cut_ms
        LEFT JOIN ck_map cm ON cm.addr = h.owner
      ),

      -- full history up to cutoff for reset detection
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
      ),
      -- attach CK to both sides of the history to detect cross-CK changes
      hist_with_ck AS (
        SELECT
          hp.\`partition\`,
          hp.token_id,
          hp.new_owner,
          cm_new.ck  AS new_ck,
          hp.prev_owner,
          cm_prev.ck AS prev_ck,
          hp.acquired_as_sale,
          hp.since_time,
          hp.block_number,
          hp.log_index
        FROM hist_pre_cut hp
        LEFT JOIN ck_map cm_new  ON cm_new.addr  = hp.new_owner
        LEFT JOIN ck_map cm_prev ON cm_prev.addr = hp.prev_owner
      ),
      -- last reset time for tokens owned at cut by our CK (sale or cross-CK)
      last_reset AS (
        SELECT
          o.\`partition\`,
          o.token_id,
          o.owner,
          o.owner_ck,
          MAX(h.since_time) AS reset_since_time
        FROM owners_at_cut o
        JOIN target_ck tck ON tck.ck = o.owner_ck
        JOIN hist_with_ck h
          ON h.\`partition\` = o.\`partition\`
         AND h.token_id    = o.token_id
         AND h.new_owner   = o.owner
         AND (h.acquired_as_sale = 1 OR h.prev_ck IS NULL OR h.prev_ck <> h.new_ck)
        WHERE o.rn = 1
        GROUP BY o.\`partition\`, o.token_id, o.owner, o.owner_ck
      ),

      -- intersect: tokens owned by this identity at cut ∩ tokens targeted by any grant
      owned_grant_targets AS (
        SELECT
          gt.grant_id,
          gt.\`partition\`,
          gt.token_id
        FROM grant_tokens gt
        JOIN owners_at_cut o
          ON o.\`partition\` = gt.\`partition\`
         AND CAST(o.token_id AS CHAR) COLLATE utf8mb4_general_ci = gt.token_id
         AND o.rn = 1
        JOIN target_ck tck ON tck.ck = o.owner_ck
      ),

      bounded_windows AS (
        SELECT
          ogt.grant_id,
          ogt.\`partition\`,
          ogt.token_id,
          GREATEST(
            COALESCE(lr.reset_since_time, 0),
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
        FROM owned_grant_targets ogt
        JOIN gr  ON gr.id = ogt.grant_id
        JOIN grant_divisor gd ON gd.id = gr.id
        LEFT JOIN last_reset lr
          ON lr.\`partition\` = ogt.\`partition\`
         AND CAST(lr.token_id AS CHAR) COLLATE utf8mb4_general_ci = ogt.token_id
      ),

      days_owned AS (
        SELECT
          bw.\`partition\`,
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

      contributors AS (
        SELECT d.\`partition\`
        FROM days_owned d
        WHERE d.tdh_rate > 0
          AND d.denom   > 0
          AND d.full_days > 0
          AND d.days_since_start >= 2
        GROUP BY d.\`partition\`
      )

      SELECT DISTINCT c.\`partition\` AS contract
      FROM contributors c
      ORDER BY c.\`partition\`;
    `;

      return await redisCached<string[]>(
        `${this.constructor.name}->getReceivedContractsByIdentity(${profileId})`,
        Time.minutes(2),
        async () => {
          const rows = await this.db.execute<{ contract: string }>(
            sql,
            {
              profile_id: profileId,
              x_tdh_epoch_ms: this.getXTdhEpochMillis()
            },
            { wrappedConnection: ctx.connection }
          );
          return rows.map((r) => r.contract.substring(2));
        }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getReceivedContractsByIdentity`
      );
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
  ): Promise<XTdhStatsMetaEntity | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getStatsMetaOrThrow`);
      const meta = this.getStatsMetaOrNull(ctx);
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
    const TABLE = slot === 'a' ? 'xtdh_token_stats_a' : 'xtdh_token_stats_b';

    const GRANT_TABLE =
      slot === 'a' ? 'xtdh_token_grant_stats_a' : 'xtdh_token_grant_stats_b';

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
          grant_count
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
      token_agg AS (
        SELECT
      g.\`partition\`,
        g.token_id,
        SUM(g.xtdh_total)      AS xtdh_total,
        SUM(g.xtdh_rate_daily) AS xtdh_rate_daily,
      COUNT(*)               AS grant_count
      FROM ${GRANT_TABLE} g
      GROUP BY g.\`partition\`, g.token_id
    )
      SELECT
      ta.\`partition\`,
        ta.token_id,
        COALESCE(o.owner, '0x0000000000000000000000000000000000000000') AS owner,
        ta.xtdh_total,
        ta.xtdh_rate_daily,
        ta.grant_count
      FROM token_agg ta
      LEFT JOIN owners_at_cut o
      ON o.\`partition\` = ta.\`partition\`
      AND o.token_id     = ta.token_id
      AND o.rn = 1
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
}

export const xTdhRepository = new XTdhRepository(dbSupplier);
