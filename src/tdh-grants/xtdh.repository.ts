import { dbSupplier, LazyDbAccessCompatibleService } from '../sql-executor';
import { RequestContext } from '../request.context';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_CONTRACTS_TABLE,
  EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE,
  IDENTITIES_TABLE,
  TDH_GRANT_TOKENS_TABLE,
  TDH_GRANTS_TABLE
} from '../constants';

//
// ─── COMMON SQL FRAGMENTS ───────────────────────────────────────────────────────
//

/** WITH cutoff (last UTC midnight in ms) */
const CTE_CUTOFF = `
cutoff AS (
  SELECT UNIX_TIMESTAMP(DATE(UTC_TIMESTAMP())) * 1000 AS cut_ms
)`;

/** WITH gr (eligible grants) – minimal fields */
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

/** WITH gr (eligible grants) – with grantor_id (used for granted_x_tdh computation) */
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

/** WITH inc_counts (INCLUDE token count per grant) */
const CTE_INC_COUNTS = `
inc_counts AS (
  SELECT grant_id, COUNT(*) AS inc_cnt
  FROM ${TDH_GRANT_TOKENS_TABLE}
  GROUP BY grant_id
)`;

/** WITH grant_divisor (per-grant denominator) */
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

/**
 * WITH grant_tokens (universe of (grant_id, partition, token_id))
 * Uses histories for ALL, and tdh_grant_tokens for INCLUDE.
 */
const CTE_GRANT_TOKENS = `
grant_tokens AS (
  SELECT
    gr.id AS grant_id,
    gr.target_partition AS \`partition\`,
    h.token_id
  FROM gr
  JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
    ON h.\`partition\` = gr.target_partition
  WHERE gr.token_mode = 'ALL'
  GROUP BY gr.id, gr.target_partition, h.token_id

  UNION ALL

  SELECT
    t.grant_id,
    t.target_partition AS \`partition\`,
    CAST(t.token_id AS CHAR) AS token_id
  FROM ${TDH_GRANT_TOKENS_TABLE} t
  JOIN gr ON gr.id = t.grant_id
  WHERE gr.token_mode = 'INCLUDE'
)`;

/** WITH ck_map (address → consolidation key) */
const CTE_CK_MAP = `
ck_map AS (
  SELECT ack.address AS addr, ack.consolidation_key AS ck
  FROM ${ADDRESS_CONSOLIDATION_KEY} ack
)`;

/** WITH owners_at_cut (current owner at last midnight + owner CK) */
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
  LEFT JOIN ck_map cm ON cm.addr = h.owner
  WHERE h.since_time < c.cut_ms
)`;

/** WITH hist_pre_cut (full history <= cutoff, with prev owner/CK for reset detection) */
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
    LAG(cm_prev.ck) OVER (
      PARTITION BY h.\`partition\`, h.token_id
      ORDER BY h.since_time, h.block_number, h.log_index
    ) AS prev_ck
  FROM ${EXTERNAL_INDEXED_OWNERSHIP_721_HISTORY_TABLE} h
  JOIN cutoff c
  LEFT JOIN ck_map cm_new  ON cm_new.addr  = h.owner
  LEFT JOIN ck_map cm_prev ON cm_prev.addr = h.owner
  WHERE h.since_time <= (SELECT cut_ms FROM cutoff)
)`;

/** WITH last_reset (last sale or cross-CK before cutoff for tokens owned at cutoff) */
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
   AND h.since_time <= (SELECT cut_ms FROM cutoff)
   AND h.new_ck      = o.owner_ck
   AND (h.acquired_as_sale = 1 OR h.prev_ck IS NULL OR h.prev_ck <> h.new_ck)
  WHERE o.rn = 1
  GROUP BY o.\`partition\`, o.token_id, o.owner, o.owner_ck
)`;

/** helper to join a WITH … chain and a trailing statement */
const withSql = (ctes: string[], tail: string) =>
  `WITH\n${ctes.join(',\n')}\n${tail}`;

export class XTdhRepository extends LazyDbAccessCompatibleService {
  async getWalletsWithoutIdentities(ctx: RequestContext): Promise<string[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getWalletsWithoutIdentities`);

      const sql = withSql(
        [
          CTE_CUTOFF,
          CTE_GR_BASE, // minimal fields are enough here
          CTE_GRANT_TOKENS,
          // owners at cut without CK is fine, but keeping the same block as used elsewhere
          // for consistency (owner CK is not used in this method).
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
 AND o.token_id    = gt.token_id
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
        `UPDATE ${IDENTITIES_TABLE} SET x_tdh = 0`,
        undefined,
        {
          wrappedConnection: ctx.connection
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteXTdhState`);
    }
  }

  async updateAllGrantedXTdhs(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->updateAllGrantedXTdhs`);

      const sql = withSql(
        [
          CTE_CK_MAP,
          CTE_CUTOFF,
          CTE_GR_WITH_GRANTOR, // includes grantor_id
          CTE_INC_COUNTS,
          CTE_GRANT_DIVISOR,
          CTE_GRANT_TOKENS,
          CTE_OWNERS_AT_CUT,
          CTE_HIST_PRE_CUT,
          CTE_LAST_RESET,
          // bounded_windows carrying grantor_id
          `
bounded_windows AS (
  SELECT
    gto.grant_id,
    gto.\`partition\`,
    gto.token_id,
    gto.owner,
    GREATEST(gto.group_start_ms, gr.valid_from) AS start_ms,
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
grantor_xtdh AS (
  SELECT
    grantor_id AS identity_id,
    SUM(x)     AS total_granted_xtdh
  FROM token_contrib
  GROUP BY grantor_id
)`
        ],
        `
UPDATE ${IDENTITIES_TABLE} i
LEFT JOIN grantor_xtdh gx
  ON gx.identity_id = i.profile_id
SET i.granted_x_tdh = COALESCE(gx.total_granted_xtdh, 0)
`
      );

      await this.db.execute(sql, undefined, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->updateAllGrantedXTdhs`);
    }
  }

  async updateAllXTdhsWithGrantedPart(ctx: RequestContext) {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->updateAllXTdhsWithGrantedPart`
      );

      const sql = withSql(
        [
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
    GREATEST(gto.group_start_ms, gr.valid_from) AS start_ms,
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
)`,
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
)`,
          `
token_contrib AS (
  SELECT
    owner,
    CASE WHEN denom > 0 THEN (tdh_rate / denom) * full_days ELSE 0 END AS x
  FROM days_owned
)`,
          `
wallet_xtdh AS (
  SELECT owner, SUM(x) AS total_xtdh
  FROM token_contrib
  GROUP BY owner
)`,
          `
identity_xtdh AS (
  SELECT
    i.profile_id AS identity_id,
    SUM(w.total_xtdh) AS total_xtdh
  FROM wallet_xtdh w
  LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack ON ack.address = w.owner
  LEFT JOIN ${IDENTITIES_TABLE} i ON i.consolidation_key = ack.consolidation_key
  GROUP BY i.profile_id
)`
        ],
        `
UPDATE ${IDENTITIES_TABLE} i
LEFT JOIN identity_xtdh x
  ON x.identity_id = i.profile_id
SET i.x_tdh = COALESCE(x.total_xtdh, 0)
`
      );

      await this.db.execute(sql, undefined, {
        wrappedConnection: ctx.connection
      });
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->insertAllGrantXTdhs`);
    }
  }

  public async giveOutUngrantedXTdh(ctx: RequestContext) {
    try {
      ctx.timer?.start(`${this.constructor.name}->giveOutUngrantedXTdh`);
      await this.db.execute(
        `UPDATE ${IDENTITIES_TABLE} SET x_tdh = x_tdh + (produced_x_tdh - granted_x_tdh)`,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->updateAllXTdhsWithGrantedPart`
      );
    }
  }
}

export const xTdhRepository = new XTdhRepository(dbSupplier);
