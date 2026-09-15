import { z } from 'zod';
import { membershipProfileSourceKeys } from './membership-profile-evaluator';
import { validateMembershipActiveInput } from './membership-evaluation-validation';
import {
  MembershipWorkerCursor,
  MembershipWorkerError,
  MembershipWorkerOptions,
  MembershipWorkerRun
} from './membership-worker.types';
import {
  assertMembershipBoundedInteger,
  normalizeCounter,
  normalizeRefreshTarget,
  normalizeSourceVector,
  orderedSourceKeys,
  MembershipSourceKey
} from './membership-validation';

export const MEMBERSHIP_WORKER_CURSOR_MAX_BYTES = 32768;
export const MEMBERSHIP_IDENTITY_KEY: MembershipSourceKey = {
  scope: 'GLOBAL',
  target_id: '*',
  dimension: 'IDENTITY'
};
export const MEMBERSHIP_FANOUT_KEYS = orderedSourceKeys([
  MEMBERSHIP_IDENTITY_KEY,
  { scope: 'GLOBAL', target_id: '*', dimension: 'GROUP_CATALOG' }
]);
export { membershipProfileSourceKeys } from './membership-profile-evaluator';

export const membershipCounterSchema = z.string().refine((value) => {
  try {
    return normalizeCounter(value) === value;
  } catch {
    return false;
  }
});
export const membershipUuidSchema = z.string().uuid();
const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const base = {
  phase: z.enum(['SCAN', 'READY_TO_FINISH', 'DONE']),
  after_id: id.nullable(),
  through_id: id.nullable(),
  traversal_collation: z
    .string()
    .max(100)
    .regex(/^utf8(mb3|mb4)?_[a-z0-9_]+$/),
  gc: z
    .object({
      retired_at_millis: membershipCounterSchema,
      after_group_id: id.nullable()
    })
    .strict()
    .optional()
};
const profileCursor = z
  .object({
    ...base,
    protocol_version: z.literal(2),
    kind: z.literal('PROFILE'),
    identity_consolidation_key: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => Buffer.byteLength(s) <= 800),
    active_input: z.unknown().refine((v) => v !== undefined)
  })
  .strict();
const fanoutCursor = z
  .object({
    ...base,
    after_id: id.max(50).nullable(),
    through_id: id.max(50).nullable(),
    protocol_version: z.literal(1),
    kind: z.literal('PROFILE_FANOUT')
  })
  .strict();

export function membershipJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function parseMembershipWorkerCursor(value: unknown): MembershipWorkerCursor {
  const decoded = membershipJson(value);
  if (
    Buffer.byteLength(JSON.stringify(decoded) ?? '') >
    MEMBERSHIP_WORKER_CURSOR_MAX_BYTES
  ) {
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Membership worker cursor exceeds byte bound'
    );
  }
  const result = z
    .discriminatedUnion('kind', [profileCursor, fanoutCursor])
    .safeParse(decoded);
  if (!result.success)
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Invalid membership worker cursor'
    );
  const cursor = result.data;
  if (cursor.kind === 'PROFILE') {
    const active =
      cursor.active_input === null
        ? null
        : validateMembershipActiveInput(cursor.active_input);
    if (active !== null && cursor.phase !== 'SCAN')
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Incomplete input cannot finish a generation'
      );
    return { ...cursor, active_input: active };
  }
  return cursor;
}

const counterFields = [
  'request_version',
  'catalog_version',
  'evaluation_time_millis',
  'checkpoint_version',
  'processed_count',
  'created_at_millis',
  'updated_at_millis'
] as const;
const nullableCounterFields = [
  'valid_until_millis',
  'lease_expires_at_millis',
  'completed_at_millis'
] as const;
const statuses = new Set([
  'PENDING',
  'RUNNING',
  'COMPLETED',
  'SUPERSEDED',
  'FAILED'
]);
function parseMembershipWorkerRun(
  row: MembershipWorkerRun
): MembershipWorkerRun {
  normalizeRefreshTarget(row);
  membershipUuidSchema.parse(row.id);
  if (!statuses.has(row.status))
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Invalid membership run status'
    );
  assertMembershipBoundedInteger(
    row.spec_version,
    'spec version',
    1,
    2147483647
  );
  const normalized = {
    ...row,
    progress_cursor: normalizeMembershipWorkerCursor(row.progress_cursor)
  };
  for (const field of counterFields)
    Object.assign(normalized, { [field]: normalizeCounter(row[field]) });
  for (const field of nullableCounterFields)
    Object.assign(normalized, {
      [field]: row[field] === null ? null : normalizeCounter(row[field])
    });
  if (row.lease_token !== null) membershipUuidSchema.parse(row.lease_token);
  if (
    (row.status === 'RUNNING') !==
      (row.lease_token !== null && row.lease_expires_at_millis !== null) ||
    (row.lease_token === null) !== (row.lease_expires_at_millis === null)
  )
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Membership lease state is inconsistent'
    );
  if (row.status === 'COMPLETED' && normalized.progress_cursor.phase !== 'DONE')
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Completed membership run lacks exhaustion'
    );
  if (
    ['RUNNING', 'PENDING'].includes(row.status) &&
    normalized.progress_cursor.gc !== undefined
  )
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Active membership run cannot be retired'
    );
  if (
    (row.scope === 'PROFILE') !==
    (normalized.progress_cursor.kind === 'PROFILE')
  )
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Membership run cursor scope mismatch'
    );
  const source_versions = normalizeSourceVector(
    membershipJson(row.source_versions),
    row.scope === 'PROFILE'
      ? membershipProfileSourceKeys(row.target_id)
      : MEMBERSHIP_FANOUT_KEYS
  );
  const catalog = source_versions.find(
    (key) => key.dimension === 'GROUP_CATALOG'
  );
  if (catalog?.version !== normalized.catalog_version)
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Membership catalogue seed mismatch'
    );
  return { ...normalized, source_versions };
}

export function validateMembershipWorkerOptions(
  options: MembershipWorkerOptions
): void {
  if (!Number.isFinite(options.deadline_monotonic_millis))
    throw new MembershipWorkerError(
      'INVALID_INPUT',
      'Invalid membership deadline'
    );
  for (const [name, value, min, max] of [
    ['transaction duration', options.transaction_millis, 1000, 60000],
    ['statement duration', options.max_statement_millis, 1, 10000],
    ['finalization reserve', options.finalization_reserve_millis, 100, 5000],
    ['checkpoint reserve', options.checkpoint_reserve_millis, 100, 5000],
    ['lock wait', options.lock_wait_seconds, 1, 5],
    ['lease duration', options.lease_millis, 1000, 600000],
    ['quanta', options.max_quanta, 1, 128],
    ['page size', options.page_size, 1, 128],
    ['retry duration', options.retry_millis, 100, 3600000],
    ['attempts', options.max_attempts, 1, 100]
  ] as const)
    assertMembershipBoundedInteger(value, name, min, max);
  if (
    options.lease_millis <= options.transaction_millis ||
    options.transaction_millis <=
      options.finalization_reserve_millis + options.checkpoint_reserve_millis
  )
    throw new MembershipWorkerError(
      'INVALID_INPUT',
      'Membership transaction and lease reserves overlap'
    );
  for (const [name, value, max] of [
    ['input queries', options.input_limits.max_queries, 10000],
    ['input rows', options.input_limits.max_input_rows, 10000000],
    ['input bytes', options.input_limits.max_input_bytes, 64000000],
    ['input windows', options.input_limits.max_windows, 10000],
    ['raw window', options.input_limits.raw_window, 256]
  ] as const)
    assertMembershipBoundedInteger(value, name, 1, max);
}

export function membershipAddCounter(
  value: string,
  increment: number | string
): string {
  return normalizeCounter(
    BigInt(normalizeCounter(value)) + BigInt(normalizeCounter(increment))
  );
}

/** Persistence violations are integrity failures, independent of parser details. */
export function normalizeMembershipWorkerCursor(
  value: unknown
): MembershipWorkerCursor {
  try {
    return parseMembershipWorkerCursor(value);
  } catch {
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Invalid membership worker cursor'
    );
  }
}
export function normalizeMembershipWorkerRun(
  value: MembershipWorkerRun
): MembershipWorkerRun {
  try {
    return parseMembershipWorkerRun(value);
  } catch {
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Invalid membership persisted run'
    );
  }
}
