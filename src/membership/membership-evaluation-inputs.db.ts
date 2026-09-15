import { performance } from 'node:perf_hooks';
import {
  ADDRESS_CONSOLIDATION_KEY,
  EXTERNAL_INDEXED_OWNERSHIP_721_TABLE,
  IDENTITIES_TABLE,
  MEMBERSHIP_GROUP_VERSIONS_TABLE,
  NFT_OWNERS_TABLE,
  PROFILE_GROUPS_TABLE,
  RATINGS_TABLE,
  USER_GROUPS_TABLE,
  WAVES_TABLE,
  WAVE_CURATIONS_TABLE,
  XTDH_GRANTS_TABLE,
  XTDH_GRANT_TOKENS_TABLE
} from '@/constants';
import type { UserGroupEntity } from '@/entities/IUserGroup';
import {
  MembershipEvaluationError,
  MembershipEvaluationQuantumInput
} from '@/membership/membership-evaluator.types';
import {
  membershipInteger,
  membershipTruth
} from '@/membership/membership-evaluation-validation';
import {
  membershipQueryOptions,
  MembershipPrimaryContext,
  assertMembershipWorkBudget
} from '@/membership/membership-primary';
import { normalizeCounter } from '@/membership/membership-validation';
import {
  SqlExecutor,
  ConnectionWrapper,
  SqlTransactionOptions
} from '@/sql-executor';
import type { DbQueryOptions } from '@/db-query.options';

export interface MembershipGroupOrder {
  character_set: string;
  collation: string;
}
export interface MembershipIdentityInput {
  profile_id: string;
  consolidation_key: string;
  tdh: unknown;
  xtdh: unknown;
  cic: unknown;
  rep: unknown;
  level_raw: unknown;
}
export interface MembershipGrantInput {
  id: string;
  status: string;
  token_mode: string;
  tokenset_id: string | null;
  target_partition: string;
  valid_from: string | null;
  valid_to: string | null;
  status_granted: boolean;
  mode_all: boolean;
  mode_include: boolean;
}
export interface MembershipGroupInput {
  group: UserGroupEntity;
  group_version: string;
  candidate: boolean;
  token_counts: number[];
  token_types: (string | null)[];
  grant_match_mode: 'ANY_TOKEN' | 'ALL_TOKENS' | null;
}
export interface MembershipRatingRow {
  rater_profile_id: string;
  matter_target_id: string;
  matter_category: string;
  rating: number;
}
export interface MembershipRatingAxis {
  matter: 'CIC' | 'REP';
  incoming: boolean;
  user: string | null;
  category: string | null;
  total: boolean;
}
export const MEMBERSHIP_TOKEN_COLUMNS = [
  'owns_meme_tokens',
  'owns_gradient_tokens',
  'owns_nextgen_tokens',
  'owns_lab_tokens'
] as const;
export const MEMBERSHIP_OWNS_COLUMNS = [
  'owns_meme',
  'owns_gradient',
  'owns_nextgen',
  'owns_lab'
] as const;
export const MEMBERSHIP_MATCH_COLUMNS = [
  'owns_meme_tokens_match_mode',
  'owns_gradient_tokens_match_mode',
  'owns_nextgen_tokens_match_mode',
  'owns_lab_tokens_match_mode'
] as const;
const scalarColumns = [
  'id',
  'profile_group_id',
  'excluded_profile_group_id',
  'cic_min',
  'cic_max',
  'cic_user',
  'cic_direction',
  'rep_min',
  'rep_max',
  'rep_user',
  'rep_direction',
  'rep_category',
  'tdh_min',
  'tdh_max',
  'tdh_inclusion_strategy',
  'level_min',
  'level_max',
  'visible',
  'is_beneficiary_of_grant_id',
  'is_beneficiary_of_grant_match_mode',
  ...MEMBERSHIP_OWNS_COLUMNS,
  ...MEMBERSHIP_MATCH_COLUMNS
];
const bounds = [
  'cic_min',
  'cic_max',
  'rep_min',
  'rep_max',
  'tdh_min',
  'tdh_max',
  'level_min',
  'level_max'
] as const;
const waveColumns = [
  'visibility_group_id',
  'admin_group_id',
  'chat_group_id',
  'participation_group_id',
  'voting_group_id'
];
const candidateSql = `g.visible=1 AND (${waveColumns.map((column) => `EXISTS(SELECT 1 FROM ${WAVES_TABLE} w WHERE w.${column}=g.id LIMIT 1)`).join(' OR ')} OR EXISTS(SELECT 1 FROM ${WAVE_CURATIONS_TABLE} wc WHERE wc.community_group_id=g.id LIMIT 1))`;

/** Counts every real statement, including source proof queries using this executor. */
export class MembershipMeteredExecutor extends SqlExecutor {
  query_count = 0;
  input_rows = 0;
  input_bytes = 0;
  constructor(
    private readonly delegate: SqlExecutor,
    readonly input: MembershipEvaluationQuantumInput,
    private readonly ctx: MembershipPrimaryContext
  ) {
    super();
  }
  canStart(
    queries = 8,
    rows = this.input.limits.raw_window + 1,
    bytes = rows === 0 ? 0 : 8192 + rows * 1024
  ): boolean {
    return (
      this.query_count + queries <= this.input.limits.max_queries &&
      this.input_rows + rows <= this.input.limits.max_input_rows &&
      this.input_bytes + bytes <= this.input.limits.max_input_bytes &&
      performance.now() + 20 < this.input.deadline_monotonic_millis
    );
  }
  async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    _options?: DbQueryOptions
  ): Promise<T[]> {
    assertMembershipWorkBudget(this.ctx);
    if (!this.canStart(1, 0))
      throw new MembershipEvaluationError(
        'RESOURCE_LIMIT',
        'Membership statement budget exhausted'
      );
    this.query_count++;
    const rows = await this.delegate.execute<T>(
      sql,
      params,
      membershipQueryOptions(this.ctx, {
        maxStatementMillis: this.input.max_query_millis,
        deadlineMonotonicMillis: this.input.deadline_monotonic_millis
      })
    );
    this.input_rows += rows.length;
    this.input_bytes += Buffer.byteLength(
      JSON.stringify(rows, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value
      )
    );
    if (
      this.input_rows > this.input.limits.max_input_rows ||
      this.input_bytes > this.input.limits.max_input_bytes
    )
      throw new MembershipEvaluationError(
        'RESOURCE_LIMIT',
        'Membership input budget exhausted'
      );
    return rows;
  }
  executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<unknown>) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    return this.delegate.executeNativeQueriesInTransaction(executable, options);
  }
}

/** All input reads use the caller's active primary snapshot. No result caches. */
export class MembershipEvaluationInputsDb {
  constructor(private readonly supplier: SqlExecutor | (() => SqlExecutor)) {}
  private get db(): SqlExecutor {
    return typeof this.supplier === 'function'
      ? this.supplier()
      : this.supplier;
  }
  async read<T>(
    sql: string,
    params: Record<string, unknown>,
    ctx: MembershipPrimaryContext
  ): Promise<T[]> {
    const name = 'MembershipEvaluationInputsDb->read';
    ctx.timer?.start(name);
    try {
      return await this.db.execute<T>(sql, params, membershipQueryOptions(ctx));
    } finally {
      ctx.timer?.stop(name);
    }
  }
  async identity(
    profile: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipIdentityInput> {
    const rows = await this.read<MembershipIdentityInput>(
      `SELECT profile_id,consolidation_key,CAST(tdh AS CHAR) tdh,xtdh,CAST(cic AS CHAR) cic,CAST(rep AS CHAR) rep,CAST(level_raw AS CHAR) level_raw FROM ${IDENTITIES_TABLE} FORCE INDEX(idx_identities_p_id_c_key) WHERE profile_id=:profile LIMIT 2`,
      { profile },
      ctx
    );
    if (rows.length === 0)
      throw new MembershipEvaluationError(
        'IDENTITY_NOT_FOUND',
        'Canonical membership identity not found'
      );
    if (rows.length !== 1 || rows[0].profile_id !== profile)
      throw new MembershipEvaluationError(
        'INTEGRITY',
        'Membership requires exactly one canonical identity'
      );
    return rows[0];
  }
  async groupOrder(
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGroupOrder> {
    const [order] = await this.read<MembershipGroupOrder>(
      `SELECT CHARACTER_SET_NAME AS character_set,COLLATION_NAME AS collation FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=:table AND column_name='id'`,
      { table: USER_GROUPS_TABLE },
      ctx
    );
    if (
      !order ||
      !/^utf8(mb3|mb4)?$/.test(order.character_set) ||
      !/^utf8(mb3|mb4)?_[a-z0-9_]+$/.test(order.collation)
    )
      throw new MembershipEvaluationError(
        'INTEGRITY',
        'Unsupported membership catalogue collation'
      );
    return order;
  }
  async isGroupRangeValid(
    id: string,
    after: string | null,
    through: string | null,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    if (through === null) return false;
    const order = await this.groupOrder(ctx);
    const cast = (param: string) =>
      `CONVERT(:${param} USING ${order.character_set}) COLLATE ${order.collation}`;
    const [row] = await this.read<{ valid: number }>(
      `SELECT (${after === null ? 'TRUE' : `${cast('id')}>${cast('after')}`} AND ${cast('id')}<=${cast('through')}) AS valid`,
      { id, after, through },
      ctx
    );
    return membershipTruth(row.valid);
  }
  async highBound(ctx: MembershipPrimaryContext): Promise<string | null> {
    const rows = await this.read<{ id: string }>(
      `SELECT g.id FROM ${USER_GROUPS_TABLE} g FORCE INDEX(PRIMARY) ORDER BY g.id DESC LIMIT 1`,
      {},
      ctx
    );
    return rows[0]?.id ?? null;
  }
  async index(
    table: string,
    prefix: string[],
    ctx: MembershipPrimaryContext
  ): Promise<string> {
    const rows = await this.read<{
      name: string;
      ordinal: number;
      column_name: string;
    }>(
      `SELECT INDEX_NAME AS name,SEQ_IN_INDEX AS ordinal,COLUMN_NAME AS column_name FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=:table ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 65`,
      { table },
      ctx
    );
    if (rows.length === 65)
      throw new MembershipEvaluationError(
        'INTEGRITY',
        'Membership source index metadata exceeds bound'
      );
    const names = Array.from(new Set(rows.map((r) => r.name)));
    const match = names.find((name) =>
      prefix.every((column, n) =>
        rows.some(
          (r) =>
            r.name === name &&
            Number(r.ordinal) === n + 1 &&
            r.column_name === column
        )
      )
    );
    if (!match || !/^[a-zA-Z0-9_]+$/.test(match))
      throw new MembershipEvaluationError(
        'INTEGRITY',
        'Required membership source index missing'
      );
    return match;
  }
  async group(
    id: string,
    catalog: string,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGroupInput | null> {
    const [row] = await this.read<Record<string, unknown>>(
      `SELECT ${scalarColumns.map((c) => `g.${c}`).join(',')},CAST(v.catalog_version AS CHAR) group_version,v.is_deleted,(${candidateSql}) candidate,CASE WHEN COALESCE(g.is_beneficiary_of_grant_match_mode,'ANY_TOKEN')='ANY_TOKEN' THEN 'ANY_TOKEN' WHEN g.is_beneficiary_of_grant_match_mode='ALL_TOKENS' THEN 'ALL_TOKENS' ELSE NULL END grant_match_mode,${MEMBERSHIP_TOKEN_COLUMNS.map((c, n) => `JSON_LENGTH(g.${c}) count_${n},JSON_TYPE(g.${c}) type_${n}`).join(',')} FROM ${USER_GROUPS_TABLE} g LEFT JOIN ${MEMBERSHIP_GROUP_VERSIONS_TABLE} v ON v.group_id=g.id WHERE g.id=:id`,
      { id },
      ctx
    );
    if (!row) {
      const [version] = await this.read<{
        is_deleted: unknown;
        version: string;
      }>(
        `SELECT is_deleted,CAST(catalog_version AS CHAR) version FROM ${MEMBERSHIP_GROUP_VERSIONS_TABLE} WHERE group_id=:id`,
        { id },
        ctx
      );
      if (
        !version ||
        !membershipTruth(version.is_deleted) ||
        BigInt(normalizeCounter(version.version)) > BigInt(catalog)
      )
        throw new MembershipEvaluationError(
          'INTEGRITY',
          'Missing membership group tombstone'
        );
      return null;
    }
    if (!membershipTruth(row.candidate)) return null;
    if (
      row.id !== id ||
      membershipTruth(row.is_deleted) ||
      row.group_version === null ||
      BigInt(normalizeCounter(row.group_version)) > BigInt(catalog)
    )
      throw new MembershipEvaluationError(
        'INTEGRITY',
        'Invalid membership group version evidence'
      );
    const group = Object.fromEntries(
      scalarColumns.map((key) => [key, row[key]])
    ) as unknown as UserGroupEntity;
    for (const key of bounds)
      Object.assign(group, {
        [key]: row[key] === null ? null : membershipInteger(row[key])
      });
    for (const key of ['visible', ...MEMBERSHIP_OWNS_COLUMNS])
      Object.assign(group, { [key]: membershipTruth(row[key]) });
    return {
      group,
      group_version: normalizeCounter(row.group_version),
      grant_match_mode:
        row.grant_match_mode as MembershipGroupInput['grant_match_mode'],
      candidate: membershipTruth(row.candidate),
      token_counts: MEMBERSHIP_TOKEN_COLUMNS.map((_c, n) =>
        row[`count_${n}`] === null ? 0 : membershipInteger(row[`count_${n}`])
      ),
      token_types: MEMBERSHIP_TOKEN_COLUMNS.map(
        (_c, n) => row[`type_${n}`] as string | null
      )
    };
  }
  async grant(
    id: string | null,
    ctx: MembershipPrimaryContext
  ): Promise<MembershipGrantInput | null> {
    if (!id) return null;
    const rows = await this.read<MembershipGrantInput>(
      `SELECT id,status,token_mode,tokenset_id,target_partition,CAST(valid_from AS CHAR) valid_from,CAST(valid_to AS CHAR) valid_to,(status='GRANTED') status_granted,(token_mode='ALL') mode_all,(token_mode='INCLUDE') mode_include FROM ${XTDH_GRANTS_TABLE} WHERE id=:id`,
      { id },
      ctx
    );
    const row = rows[0];
    return row
      ? {
          ...row,
          status_granted: membershipTruth(row.status_granted),
          mode_all: membershipTruth(row.mode_all),
          mode_include: membershipTruth(row.mode_include)
        }
      : null;
  }
  async listWindow(
    profile: string,
    group: string,
    after: string | null,
    size: number,
    ctx: MembershipPrimaryContext
  ) {
    const index = await this.index(PROFILE_GROUPS_TABLE, ['profile_id'], ctx);
    return this.read<{ list_id: string; included: number; excluded: number }>(
      `SELECT pg.profile_group_id list_id,(g.profile_group_id=pg.profile_group_id) included,(g.excluded_profile_group_id=pg.profile_group_id) excluded FROM (SELECT profile_group_id FROM ${PROFILE_GROUPS_TABLE} FORCE INDEX(${index}) WHERE profile_id=:profile ${after === null ? '' : 'AND profile_group_id>:after'} ORDER BY profile_group_id LIMIT :limit) pg JOIN ${USER_GROUPS_TABLE} g ON g.id=:group ORDER BY pg.profile_group_id`,
      { profile, group, after, limit: size + 1 },
      ctx
    );
  }
  async ratings(
    profile: string,
    axis: MembershipRatingAxis,
    after: { category: string | null; other_profile_id: string | null },
    size: number,
    ctx: MembershipPrimaryContext
  ) {
    const fixed = axis.incoming ? 'matter_target_id' : 'rater_profile_id';
    const other = axis.incoming ? 'rater_profile_id' : 'matter_target_id';
    const index = axis.incoming ? 'idx_ratings_5' : 'idx_ratings_4';
    const clauses = [`r.matter=:matter`, `r.${fixed}=:profile`];
    if (axis.user !== null) clauses.push(`r.${other}=:user`);
    if (axis.category !== null) clauses.push('r.matter_category=:category');
    // Category/other form the source index order even when an equality fixes one.
    if (after.category !== null)
      clauses.push(
        `(r.matter_category>:afterCategory OR (r.matter_category=:afterCategory AND r.${other}>:afterOther))`
      );
    return this.read<MembershipRatingRow>(
      `SELECT r.rater_profile_id,r.matter_target_id,r.matter_category,r.rating FROM ${RATINGS_TABLE} r FORCE INDEX(${axis.user !== null ? 'PRIMARY' : index}) WHERE ${clauses.join(' AND ')} ORDER BY r.matter_category,r.${other} LIMIT :limit`,
      {
        profile,
        matter: axis.matter,
        user: axis.user,
        category: axis.category,
        afterCategory: after.category,
        afterOther: after.other_profile_id,
        limit: size + 1
      },
      ctx
    );
  }
  async jsonToken(
    group: string,
    slot: number,
    ordinal: string,
    ctx: MembershipPrimaryContext
  ) {
    const column = MEMBERSHIP_TOKEN_COLUMNS[slot];
    if (!column)
      throw new MembershipEvaluationError(
        'INVALID_INPUT',
        'Invalid NFT contract slot'
      );
    const [row] = await this.read<{
      type: string;
      length: unknown;
      prefix: string;
    }>(
      `SELECT JSON_TYPE(JSON_EXTRACT(g.${column},:path)) type,CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(g.${column},:path))) length,LEFT(JSON_UNQUOTE(JSON_EXTRACT(g.${column},:path)),21) prefix FROM ${USER_GROUPS_TABLE} g WHERE g.id=:group`,
      { group, path: `$[${ordinal}]` },
      ctx
    );
    return row;
  }
  async owners(
    token: string,
    contract: string,
    after: string | null,
    size: number,
    profile: string,
    key: string,
    ctx: MembershipPrimaryContext
  ) {
    return this.read<{ wallet: string; matched: string | null }>(
      `SELECT o.wallet,i.profile_id matched FROM (SELECT n.wallet FROM ${NFT_OWNERS_TABLE} n FORCE INDEX(PRIMARY) WHERE n.token_id=:token AND n.contract=:contract ${after === null ? '' : 'AND n.wallet>:after'} ORDER BY n.wallet LIMIT :limit) o LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack ON ack.address=o.wallet LEFT JOIN ${IDENTITIES_TABLE} i ON i.consolidation_key=ack.consolidation_key AND i.consolidation_key=:key AND i.profile_id=:profile ORDER BY o.wallet`,
      { token, contract, after, limit: size + 1, key, profile },
      ctx
    );
  }
  async wallets(
    key: string,
    after: string | null,
    size: number,
    ctx: MembershipPrimaryContext
  ) {
    return this.read<{ address: string }>(
      `SELECT ack.address FROM ${ADDRESS_CONSOLIDATION_KEY} ack FORCE INDEX(address_consolidation_key_idx) WHERE ack.consolidation_key=:key ${after === null ? '' : 'AND ack.address>:after'} ORDER BY ack.address LIMIT :limit`,
      { key, after, limit: size + 1 },
      ctx
    );
  }
  async walletWitness(
    wallets: string[],
    contract: string,
    external: boolean,
    ctx: MembershipPrimaryContext
  ): Promise<boolean> {
    if (!wallets.length) return false;
    const index = external
      ? await this.index(EXTERNAL_INDEXED_OWNERSHIP_721_TABLE, ['owner'], ctx)
      : 'idx_nft_owners_1';
    const table = external
      ? EXTERNAL_INDEXED_OWNERSHIP_721_TABLE
      : NFT_OWNERS_TABLE;
    const sql = wallets
      .map(
        (_w, n) =>
          `(SELECT 1 witness FROM ${table} o FORCE INDEX(${index}) WHERE o.${external ? 'owner' : 'wallet'}=:w${n} AND o.${external ? '`partition`' : 'contract'}=:contract LIMIT 1)`
      )
      .join(' UNION ALL ');
    const rows = await this.read<{ witness: number }>(
      sql,
      { contract, ...Object.fromEntries(wallets.map((w, n) => [`w${n}`, w])) },
      ctx
    );
    return rows.length > 0;
  }
  async grantTokens(
    grant: MembershipGrantInput,
    after: string | null,
    size: number,
    profile: string,
    key: string,
    ctx: MembershipPrimaryContext
  ) {
    return this.read<{
      token_id: string;
      selected: number;
      matched: string | null;
    }>(
      `SELECT CAST(t.token_id AS CHAR) token_id,(t.target_partition=xg.target_partition) selected,i.profile_id matched FROM (SELECT token_id,target_partition FROM ${XTDH_GRANT_TOKENS_TABLE} gt FORCE INDEX(PRIMARY) WHERE gt.tokenset_id=:tokenset ${after === null ? '' : 'AND gt.token_id>:after'} ORDER BY gt.token_id LIMIT :limit) t JOIN ${XTDH_GRANTS_TABLE} xg ON xg.id=:grant LEFT JOIN ${EXTERNAL_INDEXED_OWNERSHIP_721_TABLE} e FORCE INDEX(PRIMARY) ON t.target_partition=xg.target_partition AND e.` +
        '`partition`' +
        `=xg.target_partition AND e.token_id=t.token_id LEFT JOIN ${ADDRESS_CONSOLIDATION_KEY} ack ON ack.address=e.owner LEFT JOIN ${IDENTITIES_TABLE} i ON i.consolidation_key=ack.consolidation_key AND i.consolidation_key=:key AND i.profile_id=:profile ORDER BY t.token_id`,
      {
        tokenset: grant.tokenset_id,
        grant: grant.id,
        after,
        limit: size + 1,
        profile,
        key
      },
      ctx
    );
  }
}
