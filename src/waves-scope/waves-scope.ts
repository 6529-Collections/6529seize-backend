/**
 * Which waves move to the 6529 chain and which stay on 6529.io, served from
 * MySQL as today: the chain's import rule for waves, as code, as far as
 * 6529.io's own tables can tell.
 *
 * This file is self-contained (no imports): the waves export copies it byte
 * for byte, so the export and this site never disagree about a wave.
 *
 * Before the switch-on, a wave stays, whole, when at least one reason holds:
 * - direct_message: waves.is_direct_message;
 * - records_wave: waves.id is the configured SIGNED_RECORDS_WAVE_ID (by id,
 *   never by its group; `none` means 6529.io has no records wave);
 * - members_only: waves.visibility_group_id is set;
 * - hidden_or_private_group: a group the wave uses stays: it is hidden
 *   (community_groups.visible = false), private (is_private), a direct
 *   message's group (is_direct_message), or it has no community_groups row;
 * - group_created_after_freeze: a group the wave uses was made after the
 *   waves freeze (WAVES_FREEZE_AT);
 * - chat_disabled_no_admin_group: its chat is off (waves.chat_enabled is
 *   false) and it has no admin group to post in;
 * - created_after_freeze: the wave was made after the waves freeze;
 * - parent_stays: the wave is a subwave (waves.parent_wave_id) and a wave
 *   above it, walked up to the root, has one of the reasons above, or a
 *   wave on the way up names a parent with no waves row. So a whole tree of
 *   waves stays together.
 * Every other wave moves. A group stays when it is hidden, private, a
 * direct message's, or made after the freeze.
 *
 * Two of the import rule's reasons need the identities file, which
 * 6529.io's tables don't hold: a controller the file doesn't hold, and a
 * made result naming such an author. The snapshot builder keeps those
 * waves. Until the switch-on they read as moving here, so 6529.io keeps
 * them frozen; after it they read not_on_chain and stay.
 *
 * The groups a wave uses (the walk):
 * - waves.admin_group_id and waves.chat_group_id;
 * - waves.hub_participation_config $.group_id and hub_voting_config
 *   $.group_id: the wave's own submit and vote groups, which the wave's
 *   participation_group_id and voting_group_id show when it has no native
 *   primary decision;
 * - every wave_curation_groups.community_group_id of the wave;
 * - for every decision of the wave (competitions.wave_id or legacy_wave_id
 *   is the wave, any lifecycle): participation_config $.group_id and
 *   voting_config $.group_id.
 * waves.visibility_group_id needs no walk (it makes the wave members_only).
 * waves.participation_group_id and voting_group_id are retired columns and
 * are never read; the hub configs and the decisions' configs hold those
 * groups. An empty or JSON-null group id is no group.
 *
 * After the switch-on, once the chain index is ready (it has finished a
 * full read of the chain on the expected network, which it starts only
 * after the chain's waves import completed), a wave stays unless the chain
 * holds it: the chain index names it by its LegacyId, or it was made on
 * the chain (it keeps its chain id as its 6529.io id). Such a wave also
 * has the reason not_on_chain. Direct messages and the records wave stay
 * always. Until the index is ready the rule above still decides, so a
 * wave the freeze holds stays frozen, and only a wave made on the chain
 * has moved.
 */

export enum StayReason {
  DIRECT_MESSAGE = 'direct_message',
  RECORDS_WAVE = 'records_wave',
  MEMBERS_ONLY = 'members_only',
  HIDDEN_OR_PRIVATE_GROUP = 'hidden_or_private_group',
  GROUP_CREATED_AFTER_FREEZE = 'group_created_after_freeze',
  CHAT_DISABLED_NO_ADMIN_GROUP = 'chat_disabled_no_admin_group',
  CREATED_AFTER_FREEZE = 'created_after_freeze',
  PARENT_STAYS = 'parent_stays',
  NOT_ON_CHAIN = 'not_on_chain'
}

/** The order reasons are reported in (the snapshot builder's order). */
export const STAY_REASONS: readonly StayReason[] = [
  StayReason.DIRECT_MESSAGE,
  StayReason.RECORDS_WAVE,
  StayReason.MEMBERS_ONLY,
  StayReason.HIDDEN_OR_PRIVATE_GROUP,
  StayReason.GROUP_CREATED_AFTER_FREEZE,
  StayReason.CHAT_DISABLED_NO_ADMIN_GROUP,
  StayReason.CREATED_AFTER_FREEZE,
  StayReason.PARENT_STAYS,
  StayReason.NOT_ON_CHAIN
];

/** The reasons a wave has of its own; a subwave inherits these. */
type OwnReason = Exclude<
  StayReason,
  StayReason.PARENT_STAYS | StayReason.NOT_ON_CHAIN
>;

const OWN_REASONS: readonly OwnReason[] = [
  StayReason.DIRECT_MESSAGE,
  StayReason.RECORDS_WAVE,
  StayReason.MEMBERS_ONLY,
  StayReason.HIDDEN_OR_PRIVATE_GROUP,
  StayReason.GROUP_CREATED_AFTER_FREEZE,
  StayReason.CHAT_DISABLED_NO_ADMIN_GROUP,
  StayReason.CREATED_AFTER_FREEZE
];

/** The reasons that keep a wave on 6529.io after the switch-on too. */
const ALWAYS_STAYS: readonly StayReason[] = [
  StayReason.DIRECT_MESSAGE,
  StayReason.RECORDS_WAVE
];

/** The environment variable that names the records wave. */
export const RECORDS_WAVE_ID_ENV = 'SIGNED_RECORDS_WAVE_ID';

/** How far up the walk to the root goes, against a loop in the data. */
export const MAX_WAVE_DEPTH = 64;

/** A chain id, as a wave made on the chain has it for its 6529.io id. */
const CHAIN_WAVE_ID = /^0x[0-9a-f]{64}$/i;

/** Whether this 6529.io wave id is a chain id (a wave made on the chain). */
export function isChainWaveId(id: string): boolean {
  return CHAIN_WAVE_ID.test(id);
}

export interface ScopeGroup {
  readonly id: string;
  readonly visible: boolean;
  readonly is_private: boolean;
  /** A direct message's group. */
  readonly is_direct_message?: boolean | null;
  /** community_groups.created_at, in milliseconds. */
  readonly created_at?: number | null;
}

type GroupFields = Omit<ScopeGroup, 'id'>;

/** Whether a time (ms) is after the freeze (ms, null when unknown). */
function afterFreeze(
  at: number | null | undefined,
  freezeAtMs: number | null
): boolean {
  return freezeAtMs !== null && typeof at === 'number' && at > freezeAtMs;
}

/** 6529.io marks the group hidden or private, or it is a direct message's. */
function groupMarked(group: GroupFields): boolean {
  return !group.visible || group.is_private || group.is_direct_message === true;
}

/**
 * A group stays on 6529.io when it is hidden, private or a direct
 * message's, or was made after the freeze (`freezeAtMs`, null when unknown).
 */
export function groupStays(
  group: GroupFields,
  freezeAtMs: number | null = null
): boolean {
  return groupMarked(group) || afterFreeze(group.created_at, freezeAtMs);
}

/** A wave's own fields and the group ids the walk reaches from it. */
export interface ScopeWave {
  readonly id: string;
  readonly is_direct_message: boolean | null;
  readonly visibility_group_id: string | null;
  readonly admin_group_id: string | null;
  readonly chat_group_id: string | null;
  /** $.group_id of waves.hub_participation_config and hub_voting_config. */
  readonly hub_group_ids: readonly (string | null)[];
  /** wave_curation_groups.community_group_id of the wave. */
  readonly curation_group_ids: readonly string[];
  /** participation and voting $.group_id of every decision of the wave. */
  readonly decision_group_ids: readonly (string | null)[];
  /** waves.chat_enabled; left out counts as on. */
  readonly chat_enabled?: boolean | null;
  /** waves.created_at, in milliseconds. */
  readonly created_at?: number | null;
  /** waves.parent_wave_id. */
  readonly parent_wave_id?: string | null;
  /**
   * The wave above a subwave, with its own parent; null when
   * parent_wave_id names a wave with no row.
   */
  readonly parent?: ScopeWave | null;
}

/**
 * Where the move to the 6529 chain stands, for one wave. Before the
 * switch-on the rule decides. After it, `held` is whether the chain index
 * holds the wave, or null until the index is ready; until then the rule
 * still decides, and only a wave made on the chain has moved.
 */
export type ChainState =
  | { readonly switchedOn: false }
  | { readonly switchedOn: true; readonly held: boolean | null };

export const BEFORE_SWITCH_ON: ChainState = { switchedOn: false };

export interface WaveScope {
  readonly stays: boolean;
  /**
   * Every reason that holds, in STAY_REASONS order. After the switch-on a
   * moved wave has none, and a staying wave has not_on_chain with the
   * rule's reasons.
   */
  readonly reasons: readonly StayReason[];
  /** False when SIGNED_RECORDS_WAVE_ID is unset (a mistake): no id, no none. */
  readonly recordsWaveConfigured: boolean;
  /** True when the wave has moved after the switch-on. */
  readonly movedOnChain: boolean;
}

export interface ScopeOptions {
  /** The records wave's id; null when SIGNED_RECORDS_WAVE_ID is not an id. */
  readonly recordsWaveId: string | null;
  /** SIGNED_RECORDS_WAVE_ID is set (an id or none); defaults to an id given. */
  readonly recordsWaveConfigured?: boolean;
  /** The waves freeze's time (WAVES_FREEZE_AT) in ms, or null when unknown. */
  readonly freezeAtMs?: number | null;
  /** The chain's state for the wave; BEFORE_SWITCH_ON when left out. */
  readonly chain?: ChainState;
}

function isGroupId(id: string | null | undefined): id is string {
  return typeof id === 'string' && id.length > 0;
}

/** The distinct group ids a wave uses (not its visibility group). */
export function walkedGroupIds(wave: ScopeWave): string[] {
  const ids = [
    wave.admin_group_id,
    wave.chat_group_id,
    ...wave.hub_group_ids,
    ...wave.curation_group_ids,
    ...wave.decision_group_ids
  ].filter(isGroupId);
  return Array.from(new Set(ids));
}

/** Whether the wave names a parent wave that has no row. */
function parentMissing(wave: ScopeWave): boolean {
  return isGroupId(wave.parent_wave_id) && !wave.parent;
}

/** The waves above `wave`, nearest first, up to the root (no loops). */
export function ancestorsOf(wave: ScopeWave): ScopeWave[] {
  const ancestors: ScopeWave[] = [];
  const seen = new Set<string>([wave.id]);
  let next = wave.parent ?? null;
  while (next && !seen.has(next.id) && ancestors.length < MAX_WAVE_DEPTH) {
    ancestors.push(next);
    seen.add(next.id);
    next = next.parent ?? null;
  }
  return ancestors;
}

/**
 * The group ids staysOnSite reads for this wave: the walk of the wave and
 * of every wave above it.
 */
export function scopeGroupIds(wave: ScopeWave): string[] {
  return Array.from(
    new Set([wave, ...ancestorsOf(wave)].flatMap(walkedGroupIds))
  );
}

type GroupsById = ReadonlyMap<string, GroupFields>;

/** Whether each of the wave's own reasons holds. */
function ownReasons(
  wave: ScopeWave,
  groupsById: GroupsById,
  recordsWaveId: string | null,
  freezeAtMs: number | null
): Record<OwnReason, boolean> {
  const used = walkedGroupIds(wave).map((id) => groupsById.get(id));
  const late = (group: GroupFields | undefined) =>
    group !== undefined && afterFreeze(group.created_at, freezeAtMs);
  return {
    [StayReason.DIRECT_MESSAGE]: wave.is_direct_message === true,
    [StayReason.RECORDS_WAVE]: !!recordsWaveId && wave.id === recordsWaveId,
    [StayReason.MEMBERS_ONLY]: isGroupId(wave.visibility_group_id),
    [StayReason.HIDDEN_OR_PRIVATE_GROUP]: used.some(
      (group) => group === undefined || (groupMarked(group) && !late(group))
    ),
    [StayReason.GROUP_CREATED_AFTER_FREEZE]: used.some(late),
    [StayReason.CHAT_DISABLED_NO_ADMIN_GROUP]:
      wave.chat_enabled === false && !isGroupId(wave.admin_group_id),
    [StayReason.CREATED_AFTER_FREEZE]: afterFreeze(wave.created_at, freezeAtMs)
  };
}

/**
 * Whether the wave stays on 6529.io, and why. `groupsById` holds the
 * community_groups rows of scopeGroupIds(wave); a group id with no row
 * there stays.
 */
export function staysOnSite(
  wave: ScopeWave,
  groupsById: GroupsById,
  options: ScopeOptions
): WaveScope {
  const recordsWaveConfigured =
    options.recordsWaveConfigured ?? !!options.recordsWaveId;
  const freezeAtMs = options.freezeAtMs ?? null;
  const own = ownReasons(wave, groupsById, options.recordsWaveId, freezeAtMs);
  const above = [wave, ...ancestorsOf(wave)];
  const holds: Record<StayReason, boolean> = {
    ...own,
    [StayReason.PARENT_STAYS]:
      above.some(parentMissing) ||
      above.slice(1).some((ancestor) => {
        const reasons = ownReasons(
          ancestor,
          groupsById,
          options.recordsWaveId,
          freezeAtMs
        );
        return OWN_REASONS.some((reason) => reasons[reason]);
      }),
    [StayReason.NOT_ON_CHAIN]: false
  };
  const chain = options.chain ?? BEFORE_SWITCH_ON;
  if (chain.switchedOn) {
    const alwaysStays = ALWAYS_STAYS.some((reason) => holds[reason]);
    // Before the index is ready only a wave made on the chain has moved;
    // every other wave keeps the rule, so a moving one stays frozen.
    const moved =
      !alwaysStays &&
      (chain.held === null ? isChainWaveId(wave.id) : chain.held);
    if (moved) {
      return {
        stays: false,
        reasons: [],
        recordsWaveConfigured,
        movedOnChain: true
      };
    }
    if (chain.held !== null) holds[StayReason.NOT_ON_CHAIN] = true;
  }
  const reasons = STAY_REASONS.filter((reason) => holds[reason]);
  return {
    stays: reasons.length > 0,
    reasons,
    recordsWaveConfigured,
    movedOnChain: false
  };
}

/** SIGNED_RECORDS_WAVE_ID's value for "6529.io has no records wave". */
export const NO_RECORDS_WAVE = 'none';

/**
 * SIGNED_RECORDS_WAVE_ID, read: a wave id; `none` (6529.io has no records
 * wave, set on purpose); or unset (a mistake: ops sets the id or none).
 * When it is not an id, no wave stays as records_wave. Callers log `none`
 * once and unset as an error once, per cold start.
 */
export type RecordsWaveSetting =
  | { readonly kind: 'id'; readonly id: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unset' };

export function readRecordsWaveSetting(
  env: Readonly<Record<string, string | undefined>>
): RecordsWaveSetting {
  const value = env[RECORDS_WAVE_ID_ENV]?.trim();
  if (!value) return { kind: 'unset' };
  if (value.toLowerCase() === NO_RECORDS_WAVE) return { kind: 'none' };
  return { kind: 'id', id: value };
}

/** The SQL table names the SQL form reads. */
export const SCOPE_TABLES = {
  waves: 'waves',
  groups: 'community_groups',
  curations: 'wave_curation_groups',
  decisions: 'competitions'
} as const;

/**
 * The named parameters of the SQL form: the records wave id (null when
 * unset), and the freeze time as milliseconds (for waves.created_at) and as
 * a Date (for community_groups.created_at, a DATETIME the driver writes from
 * a Date), both null when unknown.
 */
export interface ScopeSqlParams {
  readonly records: string;
  readonly freezeAtMs: string;
  readonly freezeAt: string;
}

export const SCOPE_SQL_PARAMS: ScopeSqlParams = {
  records: 'recordsWaveId',
  freezeAtMs: 'freezeAtMs',
  freezeAt: 'freezeAt'
};

/** The select's column that says the wave has moved after the switch-on. */
export const MOVED_ON_CHAIN_COLUMN = 'moved_on_chain';

/** 6529.io marks the group hidden or private, in SQL (row `alias`). */
function groupMarkedSql(alias: string): string {
  return `(${alias}.visible = 0 or coalesce(${alias}.is_private, 0) = 1 or coalesce(${alias}.is_direct_message, 0) = 1)`;
}

/** The group was made after the freeze, in SQL (row `alias`). */
function groupLateSql(alias: string, params: ScopeSqlParams): string {
  return `(:${params.freezeAt} is not null and ${alias}.created_at > :${params.freezeAt})`;
}

/**
 * A group stays, in SQL, for a community_groups row aliased `alias`: hidden,
 * private or a direct message's, or (with `params`) made after the freeze.
 */
export function groupStaysSql(alias: string, params?: ScopeSqlParams): string {
  return params
    ? `(${groupMarkedSql(alias)} or ${groupLateSql(alias, params)})`
    : groupMarkedSql(alias);
}

/** The $.group_id of JSON column `config` of row `alias`; null unless a string. */
function configGroupIdSql(alias: string, config: string): string {
  return `json_value(${alias}.${config}, '$.group_id')`;
}

/** The group ids on the waves row `alias` itself (not its visibility group). */
function waveRowGroupIdsSql(alias: string): string[] {
  return [
    `${alias}.admin_group_id`,
    `${alias}.chat_group_id`,
    configGroupIdSql(alias, 'hub_participation_config'),
    configGroupIdSql(alias, 'hub_voting_config')
  ];
}

/** "Row `d` of competitions is a decision of the waves row `alias`". */
function decisionOfSql(d: string, alias: string): string {
  return `(${d}.wave_id = ${alias}.id or ${d}.legacy_wave_id = ${alias}.id)`;
}

/**
 * "Some group the waves row `alias` uses (the walk) is a community_groups
 * row that meets `condition(g)`". One subquery a source, each joined on the
 * group's id (no derived table that reads the outer row: MySQL can answer
 * those wrongly in a `where` clause).
 */
function usesGroupSql(alias: string, condition: (g: string) => string): string {
  const g = `${alias}_g`;
  const c = `${alias}_c`;
  const d = `${alias}_d`;
  const groups = SCOPE_TABLES.groups;
  const decisionIds = `(${configGroupIdSql(d, 'participation_config')}, ${configGroupIdSql(d, 'voting_config')})`;
  return `(exists (select 1 from ${groups} ${g} where ${g}.id in (${waveRowGroupIdsSql(alias).join(', ')}) and ${condition(g)}) or exists (select 1 from ${SCOPE_TABLES.curations} ${c} join ${groups} ${g} on ${g}.id = ${c}.community_group_id where ${c}.wave_id = ${alias}.id and ${condition(g)}) or exists (select 1 from ${SCOPE_TABLES.decisions} ${d} join ${groups} ${g} on ${g}.id in ${decisionIds} where ${decisionOfSql(d, alias)} and ${condition(g)}))`;
}

/** "Some group id the waves row `alias` uses has no community_groups row". */
function usesMissingGroupSql(alias: string): string {
  const g = `${alias}_m`;
  const c = `${alias}_mc`;
  const d = `${alias}_md`;
  const noRow = (idSql: string) =>
    `(coalesce(${idSql}, '') <> '' and not exists (select 1 from ${SCOPE_TABLES.groups} ${g} where ${g}.id = ${idSql}))`;
  return `(${[
    ...waveRowGroupIdsSql(alias).map(noRow),
    `exists (select 1 from ${SCOPE_TABLES.curations} ${c} where ${c}.wave_id = ${alias}.id and ${noRow(`${c}.community_group_id`)})`,
    `exists (select 1 from ${SCOPE_TABLES.decisions} ${d} where ${decisionOfSql(d, alias)} and (${noRow(configGroupIdSql(d, 'participation_config'))} or ${noRow(configGroupIdSql(d, 'voting_config'))}))`
  ].join(' or ')})`;
}

/** Each own reason as a 0/1 expression over the waves row `alias`. */
function ownReasonsSql(
  alias: string,
  params: ScopeSqlParams
): Record<OwnReason, string> {
  return {
    [StayReason.DIRECT_MESSAGE]: `(coalesce(${alias}.is_direct_message, 0) = 1)`,
    [StayReason.RECORDS_WAVE]: `(:${params.records} is not null and ${alias}.id = :${params.records})`,
    [StayReason.MEMBERS_ONLY]: `(coalesce(${alias}.visibility_group_id, '') <> '')`,
    // A marked group not made after the freeze, or a group id with no row.
    [StayReason.HIDDEN_OR_PRIVATE_GROUP]: `(${usesGroupSql(alias, (g) => `${groupMarkedSql(g)} and not ${groupLateSql(g, params)}`)} or ${usesMissingGroupSql(alias)})`,
    [StayReason.GROUP_CREATED_AFTER_FREEZE]: usesGroupSql(alias, (g) =>
      groupLateSql(g, params)
    ),
    [StayReason.CHAT_DISABLED_NO_ADMIN_GROUP]: `(coalesce(${alias}.chat_enabled, 1) = 0 and coalesce(${alias}.admin_group_id, '') = '')`,
    [StayReason.CREATED_AFTER_FREEZE]: `(:${params.freezeAtMs} is not null and ${alias}.created_at > :${params.freezeAtMs})`
  };
}

/** "The waves row `alias` names a parent wave with no row", in SQL. */
function parentMissingSql(alias: string): string {
  const p = `${alias}_pm`;
  return `(coalesce(${alias}.parent_wave_id, '') <> '' and not exists (select 1 from ${SCOPE_TABLES.waves} ${p} where ${p}.id = ${alias}.parent_wave_id))`;
}

/**
 * parent_stays in SQL for the waves row `alias`: it names a parent with no
 * row, or a wave above it, walked up to the root (at most MAX_WAVE_DEPTH
 * steps), has an own reason or names a parent with no row. A recursive
 * common table expression that reads the outer row (MySQL 8.0.14 and
 * later).
 */
function parentStaysSql(alias: string, params: ScopeSqlParams): string {
  const anc = `${alias}_anc`;
  const step = `${alias}_up`;
  const above = `${alias}_aw`;
  const own = ownReasonsSql(above, params);
  const aboveStays = [
    ...OWN_REASONS.map((reason) => own[reason]),
    parentMissingSql(above)
  ].join(' or ');
  return `(coalesce(${alias}.parent_wave_id, '') <> '' and (${parentMissingSql(alias)} or exists (with recursive ${anc} (id, parent_wave_id, depth) as (select ${step}.id, ${step}.parent_wave_id, 1 from ${SCOPE_TABLES.waves} ${step} where ${step}.id = ${alias}.parent_wave_id union all select ${step}.id, ${step}.parent_wave_id, ${anc}.depth + 1 from ${SCOPE_TABLES.waves} ${step} join ${anc} on ${step}.id = ${anc}.parent_wave_id where ${anc}.depth < ${MAX_WAVE_DEPTH} and ${step}.id <> ${alias}.id) select 1 from ${anc} join ${SCOPE_TABLES.waves} ${above} on ${above}.id = ${anc}.id where ${aboveStays})))`;
}

/**
 * The chain's state for the SQL form. Before the switch-on the rule decides.
 * After it, `heldSql(idSql)` is the condition "the chain index holds the
 * wave whose 6529.io id is idSql", or null until the index is ready; until
 * then the rule still decides, and only a wave made on the chain has moved.
 */
export type ChainStateSql =
  | { readonly switchedOn: false }
  | {
      readonly switchedOn: true;
      readonly heldSql: ((idSql: string) => string) | null;
    };

/** "The 6529.io id in idSql is a chain id", in SQL. */
export function chainWaveIdSql(idSql: string): string {
  return `(${idSql} regexp '^0x[0-9a-fA-F]{64}$')`;
}

export interface WavesScopeSql {
  /** Each reason the SQL reads (all but not_on_chain), as a 0/1 expression. */
  readonly reasons: Readonly<
    Record<Exclude<StayReason, StayReason.NOT_ON_CHAIN>, string>
  >;
  /** After the switch-on, the wave has moved (0 before it). */
  readonly moved: string;
  /** The wave stays on 6529.io, for `where` clauses. */
  readonly stays: string;
  /**
   * For each wave: id, every reason the SQL reads and moved_on_chain.
   * scopeFromRow turns a row into a WaveScope.
   */
  readonly select: string;
}

/**
 * The SQL form (MySQL 8.0.21 or later: JSON_VALUE, and a recursive common
 * table expression that reads the outer row) for the waves row
 * aliased `alias`. Its named parameters are `params` (SCOPE_SQL_PARAMS
 * unless given), each null when unknown. "Waves that move" is
 * `not (<stays>)`. Every statement stays well under RDS Proxy's 16,000
 * bytes, past which a session is pinned.
 */
export function wavesScopeSql(
  alias = 'w',
  chain: ChainStateSql = { switchedOn: false },
  params: ScopeSqlParams = SCOPE_SQL_PARAMS
): WavesScopeSql {
  const own = ownReasonsSql(alias, params);
  const reasons = {
    ...own,
    [StayReason.PARENT_STAYS]: parentStaysSql(alias, params)
  };
  const ruleStays = `(${[...OWN_REASONS, StayReason.PARENT_STAYS as const]
    .map((reason) => reasons[reason])
    .join(' or ')})`;
  const alwaysStays = `(${own[StayReason.DIRECT_MESSAGE]} or ${own[StayReason.RECORDS_WAVE]})`;
  const moved = chain.switchedOn
    ? `(not ${alwaysStays} and ${chain.heldSql ? chain.heldSql(`${alias}.id`) : chainWaveIdSql(`${alias}.id`)})`
    : '(0 = 1)';
  // After the switch-on and before the index is ready, only a chain-made
  // wave has moved and the rule decides the rest.
  const stays = !chain.switchedOn
    ? ruleStays
    : chain.heldSql
      ? `(not ${moved})`
      : `(not ${moved} and ${ruleStays})`;
  const columns = [...OWN_REASONS, StayReason.PARENT_STAYS as const].map(
    (reason) => `${reasons[reason]} as ${reason}`
  );
  const select = `select ${alias}.id as id, ${columns.join(', ')}, ${moved} as ${MOVED_ON_CHAIN_COLUMN} from ${SCOPE_TABLES.waves} ${alias}`;
  return { reasons, moved, stays, select };
}

/**
 * A WaveScope from a row of wavesScopeSql's select (0/1 columns, numbers or
 * strings), as staysOnSite gives it for the same wave.
 */
export function scopeFromRow(
  row: Readonly<Record<string, unknown>>,
  options: {
    readonly chain: ChainStateSql;
    readonly recordsWaveConfigured: boolean;
  }
): WaveScope {
  const set = (value: unknown) => Number(value) === 1;
  const { chain, recordsWaveConfigured } = options;
  const switchedOn = chain.switchedOn;
  const ready = chain.switchedOn && chain.heldSql !== null;
  if (switchedOn && set(row[MOVED_ON_CHAIN_COLUMN])) {
    return {
      stays: false,
      reasons: [],
      recordsWaveConfigured,
      movedOnChain: true
    };
  }
  const reasons = STAY_REASONS.filter((reason) =>
    reason === StayReason.NOT_ON_CHAIN ? ready : set(row[reason])
  );
  return {
    stays: reasons.length > 0,
    reasons,
    recordsWaveConfigured,
    movedOnChain: false
  };
}

/**
 * The SQL condition "the waves row `alias` uses one of the groups
 * `:<groupsParam>`" (a non-empty list): as its visibility group or through
 * the walk.
 */
export function waveUsesGroupsSql(
  alias = 'w',
  groupsParam = 'groupIds'
): string {
  const c = `${alias}_uc`;
  const d = `${alias}_ud`;
  const ids = `(:${groupsParam})`;
  const own = [`${alias}.visibility_group_id`, ...waveRowGroupIdsSql(alias)]
    .map((column) => `${column} in ${ids}`)
    .join(' or ');
  return `(${own} or exists (select 1 from ${SCOPE_TABLES.curations} ${c} where ${c}.wave_id = ${alias}.id and ${c}.community_group_id in ${ids}) or exists (select 1 from ${SCOPE_TABLES.decisions} ${d} where ${decisionOfSql(d, alias)} and (${configGroupIdSql(d, 'participation_config')} in ${ids} or ${configGroupIdSql(d, 'voting_config')} in ${ids})))`;
}

/**
 * The SQL condition "a wave that moves uses one of the groups
 * `:<groupsParam>`" (a non-empty list), over the waves row `alias`: the
 * waves freeze holds those groups.
 */
export function movingWaveUsesGroupsSql(
  alias = 'w',
  groupsParam = 'groupIds',
  chain: ChainStateSql = { switchedOn: false },
  params: ScopeSqlParams = SCOPE_SQL_PARAMS
): string {
  return `(${waveUsesGroupsSql(alias, groupsParam)} and not ${wavesScopeSql(alias, chain, params).stays})`;
}
