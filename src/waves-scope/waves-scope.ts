/**
 * Which waves move to the 6529 chain and which stay on 6529.io, served from
 * MySQL as today: the chain's import rule for waves, as code. The plain text of
 * this rule is the moved-predicate brief; the two say the same thing.
 *
 * This file is self-contained (no imports): the waves export copies it byte
 * for byte, so the export and this site never disagree about a wave.
 *
 * Before the switch-on, a wave stays, whole, when at least one reason holds:
 * - direct_message: waves.is_direct_message;
 * - records_wave: waves.id is the configured SIGNED_RECORDS_WAVE_ID (by id,
 *   never by its group);
 * - members_only: waves.visibility_group_id is set;
 * - hidden_or_private_group: a group the wave uses is hidden
 *   (community_groups.visible = false) or private (is_private = true);
 * - parent_stays: the wave is a subwave (waves.parent_wave_id) and a wave
 *   above it, walked up to the root, has one of the reasons above, so a
 *   whole tree of waves stays together.
 * Every other wave moves. A group stays when it is hidden or private.
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
 * groups. A group id that matches no community_groups row is ignored.
 *
 * After the switch-on, a wave stays unless the chain holds it: the chain
 * index names it by its LegacyId, or it has a chain id (a wave made on the
 * chain keeps its chain id as its 6529.io id). Direct messages and the
 * records wave stay always. Until the chain index has finished its first
 * full read, a wave stays unless it was made on the chain. A wave that
 * stays after the switch-on also has the reason not_on_chain.
 */

export enum StayReason {
  MEMBERS_ONLY = 'members_only',
  HIDDEN_OR_PRIVATE_GROUP = 'hidden_or_private_group',
  DIRECT_MESSAGE = 'direct_message',
  RECORDS_WAVE = 'records_wave',
  PARENT_STAYS = 'parent_stays',
  NOT_ON_CHAIN = 'not_on_chain'
}

/** The order reasons are reported in. */
export const STAY_REASONS: readonly StayReason[] = [
  StayReason.DIRECT_MESSAGE,
  StayReason.RECORDS_WAVE,
  StayReason.MEMBERS_ONLY,
  StayReason.HIDDEN_OR_PRIVATE_GROUP,
  StayReason.PARENT_STAYS,
  StayReason.NOT_ON_CHAIN
];

/** The reasons a wave has of its own, before the switch-on. */
const OWN_REASONS: readonly StayReason[] = [
  StayReason.DIRECT_MESSAGE,
  StayReason.RECORDS_WAVE,
  StayReason.MEMBERS_ONLY,
  StayReason.HIDDEN_OR_PRIVATE_GROUP
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
}

/** A group stays on 6529.io when it is hidden or private. */
export function groupStays(
  group: Pick<ScopeGroup, 'visible' | 'is_private'>
): boolean {
  return !group.visible || group.is_private;
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
  /** The wave above a subwave (waves.parent_wave_id), with its own parent. */
  readonly parent?: ScopeWave | null;
}

/**
 * Where the move to the 6529 chain stands, for one wave. Before the
 * switch-on the rule decides. After it, `held` is whether the chain index
 * holds the wave, or null until the index has finished its first full read.
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
  /** False when SIGNED_RECORDS_WAVE_ID is unset: no wave is records_wave. */
  readonly recordsWaveConfigured: boolean;
  /** True when the wave has moved after the switch-on. */
  readonly movedOnChain: boolean;
}

export interface ScopeOptions {
  /** The configured records wave id, or null when unset. */
  readonly recordsWaveId: string | null;
  /** The chain's state for the wave; BEFORE_SWITCH_ON when left out. */
  readonly chain?: ChainState;
}

/** The distinct group ids a wave uses (not its visibility group). */
export function walkedGroupIds(wave: ScopeWave): string[] {
  const ids = [
    wave.admin_group_id,
    wave.chat_group_id,
    ...wave.hub_group_ids,
    ...wave.curation_group_ids,
    ...wave.decision_group_ids
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  return Array.from(new Set(ids));
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

type GroupsById = ReadonlyMap<
  string,
  Pick<ScopeGroup, 'visible' | 'is_private'>
>;

/** Whether each of the wave's own reasons holds. */
function ownReasons(
  wave: ScopeWave,
  groupsById: GroupsById,
  recordsWaveId: string | null
): Record<StayReason, boolean> {
  return {
    [StayReason.DIRECT_MESSAGE]: wave.is_direct_message === true,
    [StayReason.RECORDS_WAVE]: !!recordsWaveId && wave.id === recordsWaveId,
    [StayReason.MEMBERS_ONLY]: !!wave.visibility_group_id,
    [StayReason.HIDDEN_OR_PRIVATE_GROUP]: walkedGroupIds(wave).some((id) => {
      const group = groupsById.get(id);
      return group !== undefined && groupStays(group);
    }),
    [StayReason.PARENT_STAYS]: false,
    [StayReason.NOT_ON_CHAIN]: false
  };
}

/**
 * Whether the wave stays on 6529.io, and why. `groupsById` holds the
 * community_groups rows of scopeGroupIds(wave); a missing id is ignored.
 */
export function staysOnSite(
  wave: ScopeWave,
  groupsById: GroupsById,
  options: ScopeOptions
): WaveScope {
  const recordsWaveConfigured = !!options.recordsWaveId;
  const holds = ownReasons(wave, groupsById, options.recordsWaveId);
  holds[StayReason.PARENT_STAYS] = ancestorsOf(wave).some((ancestor) => {
    const above = ownReasons(ancestor, groupsById, options.recordsWaveId);
    return OWN_REASONS.some((reason) => above[reason]);
  });
  const chain = options.chain ?? BEFORE_SWITCH_ON;
  if (chain.switchedOn) {
    const alwaysStays = ALWAYS_STAYS.some((reason) => holds[reason]);
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
    holds[StayReason.NOT_ON_CHAIN] = true;
  }
  const reasons = STAY_REASONS.filter((reason) => holds[reason]);
  return {
    stays: reasons.length > 0,
    reasons,
    recordsWaveConfigured,
    movedOnChain: false
  };
}

let warnedAboutRecordsWave = false;

/**
 * The records wave id from the environment, or null when unset. When unset
 * the records wave can move with the rest, so it is logged once through
 * `warn` and every WaveScope says recordsWaveConfigured: false.
 */
export function recordsWaveIdFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  warn: (message: string) => void
): string | null {
  const id = env[RECORDS_WAVE_ID_ENV]?.trim();
  if (id) return id;
  if (!warnedAboutRecordsWave) {
    warnedAboutRecordsWave = true;
    warn(
      `[WAVES_SCOPE] [${RECORDS_WAVE_ID_ENV} IS NOT SET] ` +
        `[NO WAVE STAYS AS THE RECORDS WAVE]`
    );
  }
  return null;
}

/** The SQL table names the SQL form reads. */
export const SCOPE_TABLES = {
  waves: 'waves',
  groups: 'community_groups',
  curations: 'wave_curation_groups',
  decisions: 'competitions'
} as const;

/** A group stays, in SQL, for a community_groups row aliased `alias`. */
export function groupStaysSql(alias: string): string {
  return `(${alias}.visible = 0 or ${alias}.is_private = 1)`;
}

/** The $.group_id of JSON column `config` of row `alias`, in SQL. */
function configGroupIdSql(alias: string, config: string): string {
  return `json_unquote(json_extract(${alias}.${config}, '$.group_id'))`;
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

/** Each own reason as a 0/1 expression over the waves row `alias`. */
function ownReasonsSql(
  alias: string,
  recordsParam: string
): Record<
  | StayReason.DIRECT_MESSAGE
  | StayReason.RECORDS_WAVE
  | StayReason.MEMBERS_ONLY
  | StayReason.HIDDEN_OR_PRIVATE_GROUP,
  string
> {
  const g = `${alias}_g`;
  const c = `${alias}_c`;
  const d = `${alias}_d`;
  const decisionHidden = (config: string) =>
    `exists (select 1 from ${SCOPE_TABLES.decisions} ${d} join ${SCOPE_TABLES.groups} ${g} on ${g}.id = ${configGroupIdSql(d, config)} where (${d}.wave_id = ${alias}.id or ${d}.legacy_wave_id = ${alias}.id) and ${groupStaysSql(g)})`;
  return {
    [StayReason.DIRECT_MESSAGE]: `(coalesce(${alias}.is_direct_message, 0) = 1)`,
    [StayReason.RECORDS_WAVE]: `(:${recordsParam} is not null and ${alias}.id = :${recordsParam})`,
    [StayReason.MEMBERS_ONLY]: `(${alias}.visibility_group_id is not null)`,
    [StayReason.HIDDEN_OR_PRIVATE_GROUP]: `(exists (select 1 from ${SCOPE_TABLES.groups} ${g} where ${g}.id in (${waveRowGroupIdsSql(alias).join(', ')}) and ${groupStaysSql(g)}) or exists (select 1 from ${SCOPE_TABLES.curations} ${c} join ${SCOPE_TABLES.groups} ${g} on ${g}.id = ${c}.community_group_id where ${c}.wave_id = ${alias}.id and ${groupStaysSql(g)}) or ${decisionHidden('participation_config')} or ${decisionHidden('voting_config')})`
  };
}

/**
 * parent_stays in SQL for the waves row `alias`: a wave above it, walked up
 * to the root (at most MAX_WAVE_DEPTH steps), has an own reason. A
 * recursive common table expression that reads the outer row (MySQL 8.0.14
 * and later).
 */
function parentStaysSql(alias: string, recordsParam: string): string {
  const anc = `${alias}_anc`;
  const step = `${alias}_up`;
  const above = `${alias}_aw`;
  const own = ownReasonsSql(above, recordsParam);
  return `(${alias}.parent_wave_id is not null and exists (with recursive ${anc} (id, parent_wave_id, depth) as (select ${step}.id, ${step}.parent_wave_id, 1 from ${SCOPE_TABLES.waves} ${step} where ${step}.id = ${alias}.parent_wave_id union all select ${step}.id, ${step}.parent_wave_id, ${anc}.depth + 1 from ${SCOPE_TABLES.waves} ${step} join ${anc} on ${step}.id = ${anc}.parent_wave_id where ${anc}.depth < ${MAX_WAVE_DEPTH} and ${step}.id <> ${alias}.id) select 1 from ${anc} join ${SCOPE_TABLES.waves} ${above} on ${above}.id = ${anc}.id where ${OWN_REASONS.map((reason) => own[reason as keyof typeof own]).join(' or ')}))`;
}

/**
 * The chain's state for the SQL form. Before the switch-on the rule decides.
 * After it, `heldSql(idSql)` is the condition "the chain index holds the
 * wave whose 6529.io id is idSql", or null until the index has finished its
 * first full read.
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
  /** Each reason as a 0/1 expression over the waves row `alias`. */
  readonly reasons: Readonly<Record<StayReason, string>>;
  /** The wave stays on 6529.io. */
  readonly stays: string;
  /** For each wave: id, every reason and stays_on_site. */
  readonly select: string;
}

/**
 * The SQL form (MySQL 8) for the waves row aliased `alias`. The records
 * wave id is the named parameter `:<recordsParam>` (null when unset).
 * "Waves that move" is `not (<stays>)`.
 */
export function wavesScopeSql(
  alias = 'w',
  recordsParam = 'recordsWaveId',
  chain: ChainStateSql = { switchedOn: false }
): WavesScopeSql {
  const own = ownReasonsSql(alias, recordsParam);
  const parentStays = parentStaysSql(alias, recordsParam);
  const before = `(${[...OWN_REASONS.map((reason) => own[reason as keyof typeof own]), parentStays].join(' or ')})`;
  const alwaysStays = `(${own[StayReason.DIRECT_MESSAGE]} or ${own[StayReason.RECORDS_WAVE]})`;
  const moved = chain.switchedOn
    ? `(not ${alwaysStays} and ${chain.heldSql ? chain.heldSql(`${alias}.id`) : chainWaveIdSql(`${alias}.id`)})`
    : null;
  const reasons: Record<StayReason, string> = {
    ...own,
    [StayReason.PARENT_STAYS]: parentStays,
    [StayReason.NOT_ON_CHAIN]: moved ? `(not ${moved})` : '(0 = 1)'
  };
  const stays = moved ? `(not ${moved})` : before;
  // After the switch-on a moved wave reports no reason.
  const reported = (reason: StayReason) =>
    moved && reason !== StayReason.NOT_ON_CHAIN
      ? `(${reasons[reason]} and not ${moved})`
      : reasons[reason];
  const select = `select ${alias}.id as id, ${STAY_REASONS.map((reason) => `${reported(reason)} as ${reason}`).join(', ')}, ${stays} as stays_on_site from ${SCOPE_TABLES.waves} ${alias}`;
  return { reasons, stays, select };
}

/**
 * The SQL condition "the waves row `alias` uses one of the groups
 * `:<groupsParam>`" (a non-empty list): as its visibility, admin or chat
 * group, a hub config group, a curation group, or a decision's
 * participation or voting group.
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
  return `(${own} or exists (select 1 from ${SCOPE_TABLES.curations} ${c} where ${c}.wave_id = ${alias}.id and ${c}.community_group_id in ${ids}) or exists (select 1 from ${SCOPE_TABLES.decisions} ${d} where (${d}.wave_id = ${alias}.id or ${d}.legacy_wave_id = ${alias}.id) and (${configGroupIdSql(d, 'participation_config')} in ${ids} or ${configGroupIdSql(d, 'voting_config')} in ${ids})))`;
}

/**
 * The SQL condition "a wave that moves uses one of the groups
 * `:<groupsParam>`" (a non-empty list), over the waves row `alias`: the
 * waves freeze holds those groups.
 */
export function movingWaveUsesGroupsSql(
  alias = 'w',
  recordsParam = 'recordsWaveId',
  groupsParam = 'groupIds',
  chain: ChainStateSql = { switchedOn: false }
): string {
  return `(${waveUsesGroupsSql(alias, groupsParam)} and not ${wavesScopeSql(alias, recordsParam, chain).stays})`;
}
