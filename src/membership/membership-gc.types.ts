import { z } from 'zod';
import { MembershipRefreshTargetKey } from './membership-validation';
import {
  membershipCounterSchema,
  membershipJson,
  membershipUuidSchema
} from './membership-worker-validation';
import { MembershipWorkerError } from './membership-worker.types';

export const MEMBERSHIP_GC_CHECKPOINT_ID = 'membership-run-gc-v1';
export const MEMBERSHIP_GC_PENDING_CAPACITY = 8;
export const MEMBERSHIP_GC_TERMINAL_STATUSES = [
  'COMPLETED',
  'SUPERSEDED',
  'FAILED'
] as const;
// A discovery frontier is a raw source key. Even a malformed run ID must be
// passed durably so one corrupt row cannot pin every later healthy generation.
const scanKey = z
  .object({
    updated_at_millis: membershipCounterSchema,
    id: z
      .string()
      .max(36)
      .refine((s) => Buffer.byteLength(s) <= 144)
  })
  .strict();
const lane = z
  .object({
    status: z.enum(MEMBERSHIP_GC_TERMINAL_STATUSES),
    sweep: membershipCounterSchema,
    after: scanKey.nullable(),
    through: scanKey.nullable(),
    cutoff_millis: membershipCounterSchema.nullable()
  })
  .strict();
const pending = z
  .object({
    slot: z
      .number()
      .int()
      .min(0)
      .max(MEMBERSHIP_GC_PENDING_CAPACITY - 1),
    run_id: membershipUuidSchema,
    kind: z.enum(['PROBE', 'DELETE']),
    eligible_at_millis: membershipCounterSchema,
    claim_token: membershipUuidSchema.nullable(),
    claim_expires_at_millis: membershipCounterSchema.nullable()
  })
  .strict();
const progress = z
  .object({
    next_kind: z.enum(['DISCOVERY', 'PENDING']),
    next_terminal_lane: z.number().int().min(0).max(2),
    next_pending_slot: z
      .number()
      .int()
      .min(0)
      .max(MEMBERSHIP_GC_PENDING_CAPACITY - 1),
    lanes: z.array(lane).length(3),
    pending: z.array(pending).max(MEMBERSHIP_GC_PENDING_CAPACITY)
  })
  .strict();
export type MembershipGcScanKey = z.infer<typeof scanKey>;
export type MembershipGcLane = z.infer<typeof lane>;
export type MembershipGcPending = z.infer<typeof pending>;
export type MembershipGcProgress = z.infer<typeof progress>;

function compareKey(a: MembershipGcScanKey, b: MembershipGcScanKey): number {
  if (BigInt(a.updated_at_millis) < BigInt(b.updated_at_millis)) return -1;
  if (BigInt(a.updated_at_millis) > BigInt(b.updated_at_millis)) return 1;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

export function normalizeMembershipGcProgress(
  input: unknown
): MembershipGcProgress {
  const value = membershipJson(input);
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 8192)
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Membership GC progress exceeds byte bound'
    );
  const parsed = progress.safeParse(value);
  if (!parsed.success)
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Invalid membership GC progress'
    );
  const result = parsed.data;
  for (let i = 0; i < result.lanes.length; i++) {
    const item = result.lanes[i];
    if (
      item.status !== MEMBERSHIP_GC_TERMINAL_STATUSES[i] ||
      (item.through === null) !== (item.cutoff_millis === null) ||
      (item.after !== null &&
        (item.through === null || compareKey(item.after, item.through) > 0))
    )
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Invalid membership GC lane bounds'
      );
  }
  if (
    new Set(result.pending.map((item) => item.slot)).size !==
      result.pending.length ||
    new Set(result.pending.map((item) => item.run_id)).size !==
      result.pending.length
  )
    throw new MembershipWorkerError(
      'INTEGRITY',
      'Duplicate membership GC pending entry'
    );
  for (const item of result.pending)
    if ((item.claim_token === null) !== (item.claim_expires_at_millis === null))
      throw new MembershipWorkerError(
        'INTEGRITY',
        'Incomplete membership GC scheduling claim'
      );
  return result;
}

export function initialMembershipGcProgress(): MembershipGcProgress {
  return {
    next_kind: 'DISCOVERY',
    next_terminal_lane: 0,
    next_pending_slot: 0,
    lanes: MEMBERSHIP_GC_TERMINAL_STATUSES.map((status) => ({
      status,
      sweep: '0',
      after: null,
      through: null,
      cutoff_millis: null
    })),
    pending: []
  };
}

export interface MembershipGcHint {
  readonly run_id: string;
  readonly target: MembershipRefreshTargetKey;
  readonly pending: Pick<MembershipGcPending, 'slot' | 'claim_token'> | null;
}
export type MembershipGcOutcome =
  | 'MISSING'
  | 'PROTECTED'
  | 'QUARANTINED'
  | 'RETIRED'
  | 'TOO_YOUNG'
  | 'ELIGIBLE'
  | 'PARTIAL'
  | 'DELETED'
  | 'LOCK_BUSY';
export interface MembershipGcResult {
  readonly run_id: string;
  readonly outcome: MembershipGcOutcome;
  readonly read_count: number;
  readonly deleted_count: number;
  readonly retry_at_millis: string | null;
}
export interface MembershipGcOptions {
  readonly reader_grace_millis: number;
  readonly scan_age_millis: number;
  readonly member_batch: number;
  readonly pending_claim_millis: number;
  readonly max_attempts: number;
}
