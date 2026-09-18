import { z } from 'zod';
import { normalizeCounter } from './membership-validation';

export const MEMBERSHIP_BACKFILL_CHECKPOINT_ID = 'membership-backfill-v1';

const counter = z.string().refine((value) => {
  try {
    return normalizeCounter(value) === value;
  } catch {
    return false;
  }
});

const progressSchema = z
  .object({
    protocol_version: z.literal(1),
    generation_id: z.string().uuid(),
    bootstrap_id: z.string().min(1).max(80),
    coverage_revision: z.string().min(1).max(100),
    identity_source_version: counter,
    catalog_source_version: counter,
    full_requested_version: counter,
    started_at_millis: counter,
    state: z.enum(['RUNNING', 'PAUSED', 'SCAN_CONVERGED']),
    parent_run_id: z.string().uuid().nullable(),
    parent_request_version: counter.nullable(),
    parent_completed_at_millis: counter.nullable(),
    parent_through_id: z.string().max(50).nullable(),
    parent_processed_count: counter.nullable(),
    scan_after_id: z.string().max(50).nullable(),
    scan_started_at_millis: counter.nullable(),
    scan_pass_complete: z.boolean(),
    scan_pass_stable: z.boolean(),
    scan_pass: z.number().int().min(0),
    scanned_count: counter,
    published_count: counter,
    scheduled_boundary_count: counter,
    minimum_horizon_millis: counter.nullable(),
    pending_count: counter,
    parked_count: counter,
    missing_count: counter,
    last_observed_at_millis: counter.nullable(),
    converged_at_millis: counter.nullable()
  })
  .strict();

export type MembershipBackfillProgress = z.infer<typeof progressSchema>;

export function normalizeMembershipBackfillProgress(
  value: unknown
): MembershipBackfillProgress {
  const decoded: unknown =
    typeof value === 'string' ? JSON.parse(value) : value;
  const result = progressSchema.parse(decoded);
  if (
    result.parent_run_id === null &&
    (result.parent_request_version !== null ||
      result.parent_completed_at_millis !== null ||
      result.parent_processed_count !== null ||
      result.parent_through_id !== null)
  )
    throw new Error('Backfill parent evidence is incomplete');
  if (result.parent_run_id !== null && result.parent_request_version === null)
    throw new Error('Backfill parent request version is missing');
  if (result.state === 'SCAN_CONVERGED' && result.converged_at_millis === null)
    throw new Error('Converged backfill has no timestamp');
  return result;
}

export interface MembershipBackfillObservation {
  readonly progress: MembershipBackfillProgress;
  readonly parent_fanout_complete: boolean;
  readonly child_scan_complete: boolean;
  readonly child_publications_converged: boolean;
  /** A DB control is only operator intent. Actual halt uses the AWS mapping and rule. */
  readonly processing_halt_verified: false;
}
