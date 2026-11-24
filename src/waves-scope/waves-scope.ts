/**
 * Which waves move to the 6529 chain and which stay on 6529.io, served from
 * MySQL as today: the chain's import rule for waves, as code. The plain text of
 * this rule is the moved-predicate brief; the two say the same thing.
 *
 * This file is self-contained (no imports): the waves export copies it byte
 * for byte, so the export and this site never disagree about a wave.
 *
 * A wave stays, whole, when at least one reason holds:
 * - direct_message: waves.is_direct_message;
 * - records_wave: waves.id is the configured SIGNED_RECORDS_WAVE_ID (by id,
 *   never by its group);
 * - members_only: waves.visibility_group_id is set;
 * - hidden_or_private_group: a group the wave uses is hidden
 *   (community_groups.visible = false) or private (is_private = true).
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
 * A subwave's parent: see SUBWAVE_STAYS_WITH_PARENT.
 *
 * After the switch-on, a wave the chain index has mapped (a LegacyId, or a
 * chain id for the wave) has moved, whatever the predicate says; a wave the
 * chain index has not mapped keeps the predicate.
 */

/**
 * The subwave rule, in one place. A subwave has waves.parent_wave_id set
 * (subwaves are one level deep). While this is false the parent is not
 * walked: a subwave stays or moves on its own reasons, so a public subwave
 * of a members-only wave moves. Set to true and a subwave also stays when
 * its parent does, with its parent's reasons added to its own. Both the
 * TypeScript and the SQL forms read this constant.
 */
export const SUBWAVE_STAYS_WITH_PARENT = false;

export enum StayReason {
  MEMBERS_ONLY = 'members_only',
  HIDDEN_OR_PRIVATE_GROUP = 'hidden_or_private_group',
  DIRECT_MESSAGE = 'direct_message',
  RECORDS_WAVE = 'records_wave'
}

/** The order reasons are reported in. */
export const STAY_REASONS: readonly StayReason[] = [
  StayReason.DIRECT_MESSAGE,
  StayReason.RECORDS_WAVE,
  StayReason.MEMBERS_ONLY,
  StayReason.HIDDEN_OR_PRIVATE_GROUP
];

/** The environment variable that names the records wave. */
export const RECORDS_WAVE_ID_ENV = 'SIGNED_RECORDS_WAVE_ID';

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
  /** The parent wave of a subwave; read only under the subwave rule. */
  readonly parent?: ScopeWave | null;
}

export interface WaveScope {
  readonly stays: boolean;
  /** Every reason that holds, in STAY_REASONS order; empty when it moves. */
  readonly reasons: readonly StayReason[];
  /** False when SIGNED_RECORDS_WAVE_ID is unset: no wave is records_wave. */
  readonly recordsWaveConfigured: boolean;
  /** True when the chain index has mapped the wave (after the switch-on). */
  readonly movedOnChain: boolean;
}

export interface ScopeOptions {
  /** The configured records wave id, or null when unset. */
  readonly recordsWaveId: string | null;
  /** After the switch-on: whether the chain index has mapped the wave. */
  readonly chainMapped?: boolean;
  /** The subwave rule; SUBWAVE_STAYS_WITH_PARENT unless a test sets it. */
  readonly subwaveStaysWithParent?: boolean;
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

/**
 * The group ids staysOnSite reads for this wave: the walk, and under the
 * subwave rule its parent's walk too.
 */
export function scopeGroupIds(
  wave: ScopeWave,
  subwaveStaysWithParent: boolean = SUBWAVE_STAYS_WITH_PARENT
): string[] {
  const parent = subwaveStaysWithParent && wave.parent ? wave.parent : null;
  return Array.from(
    new Set([
      ...walkedGroupIds(wave),
      ...(parent ? walkedGroupIds(parent) : [])
    ])
  );
}

type GroupsById = ReadonlyMap<
  string,
  Pick<ScopeGroup, 'visible' | 'is_private'>
>;

/** Which reasons hold for the wave on its own. */
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
    })
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
  if (options.chainMapped) {
    return {
      stays: false,
      reasons: [],
      recordsWaveConfigured,
      movedOnChain: true
    };
  }
  const own = ownReasons(wave, groupsById, options.recordsWaveId);
  const parent =
    (options.subwaveStaysWithParent ?? SUBWAVE_STAYS_WITH_PARENT) && wave.parent
      ? ownReasons(wave.parent, groupsById, options.recordsWaveId)
      : null;
  const reasons = STAY_REASONS.filter(
    (reason) => own[reason] || (parent?.[reason] ?? false)
  );
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

/** Each reason, on its own, as a 0/1 expression over the waves row `alias`. */
function ownReasonsSql(
  alias: string,
  recordsParam: string
): Record<StayReason, string> {
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

export interface WavesScopeSql {
  /** Each reason as a 0/1 expression over the waves row `alias`. */
  readonly reasons: Readonly<Record<StayReason, string>>;
  /** The OR of the reasons: the wave stays. */
  readonly stays: string;
  /** For each wave: id, the four reasons and stays_on_site. */
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
  subwaveStaysWithParent: boolean = SUBWAVE_STAYS_WITH_PARENT
): WavesScopeSql {
  const own = ownReasonsSql(alias, recordsParam);
  const p = `${alias}_p`;
  const parent = ownReasonsSql(p, recordsParam);
  const reasons = {} as Record<StayReason, string>;
  for (const reason of STAY_REASONS)
    reasons[reason] = subwaveStaysWithParent
      ? `(${own[reason]} or exists (select 1 from ${SCOPE_TABLES.waves} ${p} where ${p}.id = ${alias}.parent_wave_id and ${parent[reason]}))`
      : own[reason];
  const stays = `(${STAY_REASONS.map((reason) => reasons[reason]).join(' or ')})`;
  const select = `select ${alias}.id as id, ${STAY_REASONS.map((reason) => `${reasons[reason]} as ${reason}`).join(', ')}, ${stays} as stays_on_site from ${SCOPE_TABLES.waves} ${alias}`;
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
  subwaveStaysWithParent: boolean = SUBWAVE_STAYS_WITH_PARENT
): string {
  return `(not ${wavesScopeSql(alias, recordsParam, subwaveStaysWithParent).stays} and ${waveUsesGroupsSql(alias, groupsParam)})`;
}
