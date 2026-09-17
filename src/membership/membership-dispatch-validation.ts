import { z } from 'zod';
import {
  assertMembershipBoundedInteger,
  normalizeCounter
} from './membership-validation';
import {
  MembershipDispatchIntegrityError,
  MembershipDispatchOptions,
  MembershipDispatchProgress
} from './membership-dispatch.types';

export const MEMBERSHIP_DISPATCH_CURSOR_BYTES = 8192;
/** Raw scheduling keys must traverse even negative physical BIGINT values. */
export function normalizeMembershipDispatchSignedCounter(
  value: unknown
): string {
  if (
    typeof value !== 'string' ||
    !/^(0|-?[1-9]\d*)$/.test(value) ||
    value.length > 20
  )
    throw new MembershipDispatchIntegrityError(
      'Invalid signed dispatch cursor'
    );
  const number = BigInt(value);
  if (
    number < BigInt('-9223372036854775808') ||
    number > BigInt('9223372036854775807')
  )
    throw new MembershipDispatchIntegrityError(
      'Dispatch cursor exceeds BIGINT'
    );
  return value;
}
const counter = z.string().refine((value) => {
  try {
    return normalizeCounter(value) === value;
  } catch {
    return false;
  }
});
const signedCounter = z.string().refine((value) => {
  try {
    return normalizeMembershipDispatchSignedCounter(value) === value;
  } catch {
    return false;
  }
});
// Physical varchar values may be empty or noncanonical; candidate validation is later.
const rawString = (length: number) =>
  z
    .string()
    .max(length * 2)
    .refine(
      (value) =>
        Array.from(value).length <= length &&
        Buffer.byteLength(value) <= length * 4
    );
const rawKey = z
  .object({ scope: rawString(20), target_id: rawString(200) })
  .strict();
const dueKey = rawKey.extend({ available_at_millis: signedCounter }).strict();
const progressSchema = z
  .object({
    next_lane: z.enum(['DUE', 'TARGET_PK']),
    due: z
      .object({
        sweep: counter,
        cutoff_millis: counter.nullable(),
        through: dueKey.nullable(),
        after: dueKey.nullable()
      })
      .strict(),
    target_pk: z
      .object({
        sweep: counter,
        through: rawKey.nullable(),
        after: rawKey.nullable()
      })
      .strict()
  })
  .strict();

export function initialMembershipDispatchProgress(): MembershipDispatchProgress {
  return {
    next_lane: 'DUE',
    due: { sweep: '0', cutoff_millis: null, through: null, after: null },
    target_pk: { sweep: '0', through: null, after: null }
  };
}

export function normalizeMembershipDispatchProgress(
  value: unknown
): MembershipDispatchProgress {
  try {
    if (
      typeof value === 'string' &&
      Buffer.byteLength(value) > MEMBERSHIP_DISPATCH_CURSOR_BYTES
    )
      throw new Error('Oversized dispatch JSON');
    const parsed: unknown =
      typeof value === 'string' ? JSON.parse(value) : value;
    if (
      Buffer.byteLength(JSON.stringify(parsed) ?? '') >
      MEMBERSHIP_DISPATCH_CURSOR_BYTES
    )
      throw new Error('Oversized dispatch JSON');
    const result = progressSchema.parse(parsed);
    const due = result.due;
    if (
      (due.through === null) !== (due.cutoff_millis === null) ||
      (due.through === null && due.after !== null) ||
      (result.target_pk.through === null && result.target_pk.after !== null)
    )
      throw new Error('Unpaired dispatch bounds');
    if (
      due.through &&
      BigInt(due.through.available_at_millis) > BigInt(due.cutoff_millis!)
    )
      throw new Error('Dispatch high bound exceeds cutoff');
    // String ordering is checked in SQL using actual source-column collations.
    return result;
  } catch {
    throw new MembershipDispatchIntegrityError(
      'Invalid membership dispatch progress'
    );
  }
}

export function validateMembershipDispatchOptions(
  options: MembershipDispatchOptions
): void {
  if (!Number.isFinite(options.deadline_monotonic_millis))
    throw new Error('Invalid dispatch deadline');
  for (const field of ['control_millis', 'target_millis'] as const)
    assertMembershipBoundedInteger(options[field], field, 100, 10000);
  assertMembershipBoundedInteger(
    options.send_millis,
    'dispatch send time',
    1,
    10000
  );
  assertMembershipBoundedInteger(
    options.cleanup_reserve_millis,
    'dispatch cleanup',
    100,
    5000
  );
  assertMembershipBoundedInteger(
    options.finalization_reserve_millis,
    'dispatch finalization',
    10,
    2000
  );
  assertMembershipBoundedInteger(
    options.max_statement_millis,
    'dispatch statement',
    1,
    3000
  );
  assertMembershipBoundedInteger(
    options.lock_wait_seconds,
    'dispatch lock wait',
    1,
    3
  );
  assertMembershipBoundedInteger(
    options.reservation_millis,
    'dispatch reservation',
    1000,
    120000
  );
  assertMembershipBoundedInteger(
    options.max_candidates,
    'dispatch candidates',
    1,
    120
  );
  assertMembershipBoundedInteger(
    options.max_per_lane,
    'dispatch lane candidates',
    1,
    60
  );
  if (
    options.control_millis <= options.finalization_reserve_millis ||
    options.target_millis <= options.finalization_reserve_millis
  )
    throw new Error('Dispatch transaction lacks work allowance');
}

export function isMembershipDispatchLockBusy(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (
    ('errno' in error && error.errno === 3572) ||
    ('code' in error && error.code === 'ER_LOCK_NOWAIT') ||
    ('serverCode' in error && error.serverCode === 'ER_LOCK_NOWAIT')
  );
}
