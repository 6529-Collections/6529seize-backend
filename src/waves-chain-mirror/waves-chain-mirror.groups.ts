import {
  GroupBeneficiaryGrantMatchMode,
  GroupNftOwnershipMatchMode,
  GroupTdhInclusionStrategy,
  FilterDirection,
  UserGroupEntity
} from '@/entities/IUserGroup';
import { chainIdOf, legacyIdOf } from './waves-chain-mirror.ids';
import { timeOf } from './waves-chain-mirror.plan-support';

/**
 * The chain's groups in 6529.io's community_groups and profile_groups
 * A group made on the chain is written under its chain id; an
 * imported group keeps 6529.io's own row until the chain replaces it
 * (GROUP_REPLACED, a version above the imported 1), and is then rewritten
 * from the chain's definition in place.
 *
 * The two agree on membership: excluded, so out; listed,
 * so in; else every criterion holds (ALL_CLAUSES), or nobody (LIST_ONLY).
 * The waves import mapped 6529.io's groups this way; this
 * is its inverse:
 *
 *   tdh (and tdh_xtdh, read as TDH)  tdh_min/max, strategy TDH
 *   rep                              rep_min/max, rep_category the
 *                                    category's name, rep_user the rater
 *                                    (direction RECEIVED)
 *   nic                              cic_min/max
 *   level                            level_min/max
 *   includes, excludes               a profile_groups list each
 *
 * A bound at +-maxVoteAbs is no bound. Two clauses on one metric are both
 * required, so their ranges intersect; the import writes a criterion that
 * admits nobody as two that never meet, which stays a range nobody is in.
 * ALL_CLAUSES whose clauses all fall away (none, or only unbounded ones)
 * admits everyone not excluded. 6529.io reads a group row with no
 * criterion and no list as nobody, and a list alone as its only members,
 * so such a group gets a criterion every identity meets (tdh_min 0: TDH is
 * never negative) and no include list. A wave keeps such a group as its
 * read group, as the relays do: every signed-in profile meets it, and a
 * signed-out reader doesn't (a wave with no read group is the public one).
 */

/** The chain's maxVoteAbs (rule version 1's MAX_VOTE_ABS, 2^53 - 1). */
export const MAX_VOTE_ABS = BigInt(Number.MAX_SAFE_INTEGER);

export interface GroupMember {
  readonly kind: 'principal' | 'address';
  /** A principal id or an address, lowercase. */
  readonly value: string;
}

export interface ChainClause {
  readonly metric: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly rater: string | null;
  readonly min: bigint;
  readonly max: bigint;
}

export interface ChainGroupDefinition {
  readonly version: number;
  readonly mode: string;
  readonly clauses: readonly ChainClause[];
  readonly includes: readonly GroupMember[];
  readonly excludes: readonly GroupMember[];
  readonly storedIncludes: number;
  readonly storedExcludes: number;
}

/** A row of chain_groups, as the mirror reads it. */
export interface ChainGroup {
  readonly groupId: string;
  readonly legacyId: string | null;
  readonly version: number;
  readonly origin: string;
  readonly controller: string | null;
  /** The block time of the current version's write (ms). */
  readonly activeFrom: number | null;
  /**
   * The chain height the index wrote the row at (at or above the current
   * version's write); null when not read.
   */
  readonly height: number | null;
  readonly definition: ChainGroupDefinition | null;
}

export interface ChainGroupRow {
  readonly group_id: string;
  readonly legacy_id: string | null;
  readonly version: number | string;
  readonly origin: string;
  /** The chain height the index wrote the row at. */
  readonly height?: number | string | null;
  readonly data: unknown;
}

const ZERO_WORD = /^0x0{64}$/;

function wordOf(value: unknown): string | null {
  const id = chainIdOf(value);
  return id && !ZERO_WORD.test(id) ? id : null;
}

function bigOf(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}

function memberOf(value: unknown): GroupMember | null {
  const item = value as Record<string, unknown> | null;
  const text = typeof item?.value === 'string' ? item.value.toLowerCase() : '';
  if (item?.kind === 'principal' && wordOf(text)) {
    return { kind: 'principal', value: text };
  }
  if (item?.kind === 'address' && /^0x[0-9a-f]{40}$/.test(text)) {
    return { kind: 'address', value: text };
  }
  return null;
}

function listOf<T>(value: unknown, item: (v: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const v of value) {
    const parsed = item(v);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function clauseOf(value: unknown): ChainClause | null {
  const c = value as Record<string, unknown> | null;
  if (!c || typeof c.metric !== 'string') return null;
  const min = bigOf(c.min);
  const max = bigOf(c.max);
  if (min === null || max === null) return null;
  const category = c.category as Record<string, unknown> | null | undefined;
  const categoryId = category ? wordOf(category.id) : null;
  return {
    metric: c.metric,
    categoryId,
    categoryName:
      categoryId && typeof category?.name === 'string' ? category.name : null,
    rater: wordOf(c.rater),
    min,
    max
  };
}

/** A group's current definition, or null when it can't be read. */
export function groupDefinitionOf(data: unknown): ChainGroupDefinition | null {
  const d = (data as Record<string, unknown> | null)?.definition as
    | Record<string, unknown>
    | null
    | undefined;
  if (!d) return null;
  const clauses = listOf(d.clauses, clauseOf);
  const includes = listOf(d.includes, memberOf);
  const excludes = listOf(d.excludes, memberOf);
  const version = Number(d.version);
  if (!clauses || !includes || !excludes || !Number.isSafeInteger(version)) {
    return null;
  }
  return {
    version,
    mode: String(d.predicateMode),
    clauses,
    includes,
    excludes,
    storedIncludes: Number(d.storedIncludes ?? 0) || 0,
    storedExcludes: Number(d.storedExcludes ?? 0) || 0
  };
}

/** A JSON column's object (the driver may hand it over as text). */
export function jsonObjectOf(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function chainGroupOf(row: ChainGroupRow): ChainGroup {
  const data = jsonObjectOf(row.data);
  return {
    groupId: row.group_id.toLowerCase(),
    legacyId: legacyIdOf(row.legacy_id),
    version: Number(row.version),
    origin: row.origin,
    controller: wordOf(data.controller),
    activeFrom: timeOf(data.activeFrom),
    height:
      row.height === undefined || row.height === null
        ? null
        : Number(row.height),
    definition: groupDefinitionOf(data)
  };
}

/** A group's criteria in community_groups' columns; its rater a principal. */
export interface GroupCriteria {
  readonly tdh_min: number | null;
  readonly tdh_max: number | null;
  readonly rep_min: number | null;
  readonly rep_max: number | null;
  readonly rep_category: string | null;
  readonly rep_rater: string | null;
  readonly cic_min: number | null;
  readonly cic_max: number | null;
  readonly level_min: number | null;
  readonly level_max: number | null;
}

export const NO_CRITERIA: GroupCriteria = {
  tdh_min: null,
  tdh_max: null,
  rep_min: null,
  rep_max: null,
  rep_category: null,
  rep_rater: null,
  cic_min: null,
  cic_max: null,
  level_min: null,
  level_max: null
};

/** A criterion every identity meets: TDH is never negative. */
export const EVERYONE_CRITERIA: GroupCriteria = { ...NO_CRITERIA, tdh_min: 0 };

export type GroupShape =
  | {
      readonly ok: true;
      readonly criteria: GroupCriteria;
      /** The include list; null for none (not an empty list). */
      readonly includes: readonly GroupMember[] | null;
      readonly excludes: readonly GroupMember[];
    }
  | { readonly ok: false; readonly reason: string };

type Range = { min: bigint | null; max: bigint | null };

function within(range: Range | undefined, clause: ChainClause): Range {
  const min = clause.min <= -MAX_VOTE_ABS ? null : clause.min;
  const max = clause.max >= MAX_VOTE_ABS ? null : clause.max;
  if (!range) return { min, max };
  return {
    min:
      range.min === null
        ? min
        : min === null || range.min > min
          ? range.min
          : min,
    max:
      range.max === null
        ? max
        : max === null || range.max < max
          ? range.max
          : max
  };
}

const asNumber = (value: bigint | null): number | null =>
  value === null ? null : Number(value);

/** What a definition means in community_groups' terms. */
export function groupShapeOf(def: ChainGroupDefinition): GroupShape {
  if (def.storedIncludes > 0 || def.storedExcludes > 0) {
    // Only the import writes stored lists, and it writes version 1.
    return { ok: false, reason: 'group_stored_members' };
  }
  if (def.mode === 'list_only') {
    return {
      ok: true,
      criteria: NO_CRITERIA,
      includes: def.includes,
      excludes: def.excludes
    };
  }
  if (def.mode !== 'all_clauses') {
    return { ok: false, reason: 'group_mode_unknown' };
  }
  const ranges: Record<string, Range> = {};
  let rep: { category: string | null; rater: string | null } | null = null;
  for (const clause of def.clauses) {
    let metric = clause.metric;
    if (metric === 'tdh_xtdh') metric = 'tdh';
    if (!['tdh', 'rep', 'nic', 'level'].includes(metric)) {
      return { ok: false, reason: 'group_metric_unknown' };
    }
    if (metric === 'rep') {
      if (clause.categoryId && clause.categoryName === null) {
        return { ok: false, reason: 'group_rep_category_unnamed' };
      }
      const key = { category: clause.categoryName, rater: clause.rater };
      if (rep && (rep.category !== key.category || rep.rater !== key.rater)) {
        // 6529.io keeps one REP criterion.
        return { ok: false, reason: 'group_rep_clauses' };
      }
      rep = key;
    }
    ranges[metric] = within(ranges[metric], clause);
  }
  const criteria: GroupCriteria = {
    tdh_min: asNumber(ranges.tdh?.min ?? null),
    tdh_max: asNumber(ranges.tdh?.max ?? null),
    rep_min: asNumber(ranges.rep?.min ?? null),
    rep_max: asNumber(ranges.rep?.max ?? null),
    rep_category: rep?.category ?? null,
    rep_rater: rep?.rater ?? null,
    cic_min: asNumber(ranges.nic?.min ?? null),
    cic_max: asNumber(ranges.nic?.max ?? null),
    level_min: asNumber(ranges.level?.min ?? null),
    level_max: asNumber(ranges.level?.max ?? null)
  };
  if (Object.values(criteria).every((value) => value === null)) {
    // Every clause holds for everyone: everyone not excluded.
    return {
      ok: true,
      criteria: EVERYONE_CRITERIA,
      includes: null,
      excludes: def.excludes
    };
  }
  return {
    ok: true,
    criteria,
    includes: def.includes,
    excludes: def.excludes
  };
}

/**
 * The name of a group made on the chain: its definition document is named
 * by commitment only, so its own name can't be read.
 */
export function nativeGroupName(groupId: string): string {
  return `Group ${groupId.slice(0, 10)}`;
}

/**
 * The community_groups row of a chain group: its criteria (the REP rater
 * as a profile), its lists, and what 6529.io keeps of its own (name, times,
 * visibility). NFT and grant criteria the chain has none of are off.
 */
export function groupRowOf(input: {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly criteria: GroupCriteria;
  readonly repUser: string | null;
  readonly includeListId: string | null;
  readonly excludeListId: string | null;
  readonly visible: boolean;
  readonly isPrivate: boolean;
}): Omit<UserGroupEntity, 'is_pure_profile_group'> {
  const { criteria } = input;
  return {
    id: input.id,
    name: input.name,
    cic_min: criteria.cic_min,
    cic_max: criteria.cic_max,
    cic_user: null,
    cic_direction: null,
    rep_min: criteria.rep_min,
    rep_max: criteria.rep_max,
    rep_user: input.repUser,
    rep_direction: input.repUser ? FilterDirection.Received : null,
    rep_category: criteria.rep_category,
    tdh_min: criteria.tdh_min,
    tdh_max: criteria.tdh_max,
    tdh_inclusion_strategy: GroupTdhInclusionStrategy.TDH,
    level_min: criteria.level_min,
    level_max: criteria.level_max,
    created_at: input.createdAt,
    created_by: input.createdBy,
    visible: input.visible,
    owns_meme: false,
    owns_meme_tokens: null,
    owns_meme_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_gradient: false,
    owns_gradient_tokens: null,
    owns_gradient_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_nextgen: false,
    owns_nextgen_tokens: null,
    owns_nextgen_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    owns_lab: false,
    owns_lab_tokens: null,
    owns_lab_tokens_match_mode: GroupNftOwnershipMatchMode.ALL_TOKENS,
    profile_group_id: input.includeListId,
    excluded_profile_group_id: input.excludeListId,
    is_private: input.isPrivate,
    is_direct_message: false,
    is_beneficiary_of_grant_id: null,
    is_beneficiary_of_grant_match_mode: GroupBeneficiaryGrantMatchMode.ANY_TOKEN
  };
}
