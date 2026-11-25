/**
 * Which groups the 6529 chain can't evaluate, so the waves import takes them
 * as their members at the freeze (the import's fallback for such a group).
 * The same rule as the waves snapshot tooling's groups.py `criteria_reasons`,
 * over the API group object (`ApiGroupFull.group`); the export writes the
 * members of exactly these groups, as the public exporter reads them from
 * /community-members/top.
 */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function isSet(filter: Json, ...keys: string[]): boolean {
  return keys.some((key) => filter[key] !== null && filter[key] !== undefined);
}

/**
 * Whether TDH plus xTDH (`inclusion_strategy` BOTH) is a clause the chain
 * evaluates. The snapshot tooling's `--both-metric` turns it on once rule
 * version 7 names the metric; until then such groups come in as members.
 */
export interface GroupCriteriaOptions {
  readonly bothMetric: boolean;
}

/** Why the chain can't evaluate this group's criteria (empty: it can). */
export function groupCriteriaReasons(
  group: unknown,
  { bothMetric }: GroupCriteriaOptions = { bothMetric: false }
): string[] {
  const d = asObject(group);
  const why: string[] = [];
  const tdh = asObject(d.tdh);
  const strategy =
    typeof tdh.inclusion_strategy === 'string' && tdh.inclusion_strategy
      ? tdh.inclusion_strategy
      : 'TDH';
  if (
    isSet(tdh, 'min', 'max') &&
    strategy !== 'TDH' &&
    !(strategy === 'BOTH' && bothMetric)
  ) {
    why.push(`tdh strategy ${strategy}`);
  }
  const rep = asObject(d.rep);
  if (isSet(rep, 'min', 'max') || rep.user_identity || rep.category) {
    if ((rep.direction || 'RECEIVED') !== 'RECEIVED') {
      why.push('rep sent');
    }
    if (rep.user_identity && !rep.category) {
      why.push('rep user without category');
    }
  }
  const cic = asObject(d.cic);
  if (isSet(cic, 'min', 'max') || cic.user_identity) {
    if ((cic.direction || 'RECEIVED') !== 'RECEIVED') {
      why.push('nic sent');
    }
    if (cic.user_identity) {
      why.push('nic user');
    }
  }
  if (Array.isArray(d.owns_nfts) ? d.owns_nfts.length > 0 : !!d.owns_nfts) {
    why.push('nft ownership');
  }
  if (d.is_beneficiary_of_grant_id) {
    why.push('xtdh beneficiary');
  }
  return why;
}

/** The raters a group's REP and NIC criteria name (a handle or an id). */
export function groupRaterKeys(group: unknown): string[] {
  const d = asObject(group);
  return ['rep', 'cic']
    .map((key) => asObject(d[key]).user_identity)
    .filter((value): value is string => typeof value === 'string' && !!value);
}
