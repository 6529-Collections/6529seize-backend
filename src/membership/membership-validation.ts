import type {
  MembershipRefreshScope,
  MembershipSourceDimension,
  MembershipSourceScope,
  MembershipSourceVersion
} from '@/membership/membership-schema.types';

export interface MembershipSourceKey {
  readonly scope: MembershipSourceScope;
  readonly target_id: string;
  readonly dimension: MembershipSourceDimension;
}

export interface MembershipRefreshTargetKey {
  readonly scope: MembershipRefreshScope;
  readonly target_id: string;
}

export const MAX_MEMBERSHIP_SOURCE_KEYS = 64;
export const MAX_MEMBERSHIP_COUNTER = '9223372036854775807';

const SOURCE_DIMENSIONS: readonly MembershipSourceDimension[] = [
  'TDH_XTDH',
  'RATINGS',
  'OWNERSHIP',
  'DELEGATIONS',
  'GRANTS',
  'IDENTITY',
  'GROUP_CATALOG'
];

export function assertMembershipRecord(
  value: unknown,
  name: string
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid membership ${name}: expected an object`);
  }
}

/** Preserve canonical IDs exactly; whitespace/case normalization aliases keys. */
export function assertMembershipId(
  value: unknown,
  name: string,
  maxLength: number
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`Invalid membership ${name}: expected a canonical ID`);
  }
}

export function assertMembershipBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Invalid membership ${name}: expected a bounded integer`);
  }
}

/** Never round native driver counters through Number or accept ambiguous JSON. */
export function normalizeCounter(value: unknown): string {
  if (typeof value === 'number') {
    assertMembershipBoundedInteger(
      value,
      'counter',
      0,
      Number.MAX_SAFE_INTEGER
    );
    return value.toString();
  }
  const decimal = typeof value === 'bigint' ? value.toString() : value;
  if (
    typeof decimal !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(decimal) ||
    (decimal.length === MAX_MEMBERSHIP_COUNTER.length &&
      decimal > MAX_MEMBERSHIP_COUNTER)
  ) {
    throw new Error(
      'Invalid membership counter: expected a nonnegative BIGINT'
    );
  }
  return decimal;
}

export function normalizeSourceKey(value: unknown): MembershipSourceKey {
  assertMembershipRecord(value, 'source key');
  const { scope, target_id, dimension } = value;
  if (scope !== 'GLOBAL' && scope !== 'PROFILE') {
    throw new Error('Invalid membership source scope');
  }
  if (
    !SOURCE_DIMENSIONS.includes(dimension as MembershipSourceDimension) ||
    (dimension === 'GROUP_CATALOG' && scope !== 'GLOBAL')
  ) {
    throw new Error('Invalid membership source dimension');
  }
  if (scope === 'GLOBAL') {
    if (target_id !== '*') {
      throw new Error('Invalid membership GLOBAL target');
    }
  } else {
    assertMembershipId(target_id, 'profile ID', 100);
  }
  return {
    scope,
    target_id: target_id as string,
    dimension: dimension as MembershipSourceDimension
  };
}

function sourceKeyId(key: MembershipSourceKey): string {
  return `${key.scope}/${key.target_id}/${key.dimension}`;
}

function compareSourceKeys(a: MembershipSourceKey, b: MembershipSourceKey) {
  return (
    compareBinary(a.scope, b.scope) ||
    compareBinary(a.target_id, b.target_id) ||
    compareBinary(a.dimension, b.dimension)
  );
}

function compareBinary(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Matches binary key ordering and locks GLOBAL before PROFILE rows. */
export function orderedSourceKeys(
  keys: readonly MembershipSourceKey[]
): MembershipSourceKey[] {
  if (!Array.isArray(keys) || keys.length > MAX_MEMBERSHIP_SOURCE_KEYS) {
    throw new Error('Invalid membership source keys: batch exceeds limit');
  }
  const normalized = keys.map(normalizeSourceKey).sort(compareSourceKeys);
  const seen = new Set<string>();
  for (const key of normalized) {
    const id = sourceKeyId(key);
    if (seen.has(id)) {
      throw new Error('Invalid membership source keys: duplicate key');
    }
    seen.add(id);
  }
  return normalized;
}

export function normalizeSourceVector(
  input: unknown,
  expectedKeys: readonly MembershipSourceKey[]
): MembershipSourceVersion[] {
  const expected = orderedSourceKeys(expectedKeys);
  if (!Array.isArray(input) || input.length !== expected.length) {
    throw new Error('Invalid membership source vector: incomplete coverage');
  }
  const entries = new Map<string, MembershipSourceVersion>();
  for (const value of input) {
    const key = normalizeSourceKey(value);
    const id = sourceKeyId(key);
    if (entries.has(id)) {
      throw new Error('Invalid membership source vector: duplicate key');
    }
    assertMembershipRecord(value, 'source version');
    entries.set(id, { ...key, version: normalizeCounter(value.version) });
  }
  return expected.map((key) => {
    const entry = entries.get(sourceKeyId(key));
    if (!entry) {
      throw new Error(
        'Invalid membership source vector: unknown or missing key'
      );
    }
    return entry;
  });
}

export function normalizeRefreshTarget(
  value: unknown
): MembershipRefreshTargetKey {
  assertMembershipRecord(value, 'refresh target');
  const { scope, target_id } = value;
  if (scope === 'FULL') {
    if (target_id !== '*') {
      throw new Error('Invalid membership FULL target');
    }
  } else if (scope === 'PROFILE' || scope === 'GROUP') {
    assertMembershipId(
      target_id,
      `${scope} target`,
      scope === 'PROFILE' ? 100 : 200
    );
  } else {
    throw new Error('Invalid membership refresh scope');
  }
  return { scope, target_id: target_id as string };
}
