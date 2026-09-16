import { z } from 'zod';
import { normalizeCounter } from './membership-validation';

const counter = z.string().refine((value) => {
  try {
    return normalizeCounter(value) === value;
  } catch {
    return false;
  }
});
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f\d]{64}$/);

/** Private fixture state. Every carrier response must redact lease_token. */
const proofShape = z
  .object({
    protocol_version: z.literal(1),
    phase: z.enum([
      'LEASE_WAIT',
      'LEASE_REPLAY',
      'EMPTY_SETTLE',
      'GC_OVERLAP',
      'GC_GRACE',
      'DONE',
      'INTERRUPTED'
    ]),
    owner: z
      .object({ request_id: uuid, expires_at_millis: counter })
      .strict()
      .nullable(),
    lease: z
      .object({
        run_id: uuid,
        checkpoint_version: counter,
        lease_token: uuid.nullable(),
        claimed_at_millis: counter,
        expires_at_millis: counter,
        request_version: counter,
        successor_checkpoint_version: counter.nullable(),
        checkpoint_fenced: z.boolean(),
        completion_fenced: z.boolean(),
        failure_fenced: z.boolean()
      })
      .strict(),
    gc: z
      .object({
        old_run_id: uuid,
        request_version: counter,
        new_run_id: uuid.nullable(),
        member_count: z.number().int().min(1).max(36),
        member_hash: digest,
        reader_connection_id: counter.nullable(),
        writer_connection_id: counter.nullable(),
        reader_verified_at_millis: counter.nullable(),
        retired_at_millis: counter.nullable(),
        eligible_at_millis: counter.nullable(),
        deleted_count: z.number().int().min(0).max(36)
      })
      .strict()
      .nullable(),
    completed_at_millis: counter.nullable(),
    interruption: z.enum(['READER_OVERLAP_LOST']).nullable()
  })
  .strict();

export type MembershipFixtureDbProof = z.infer<typeof proofShape>;

function validLease(proof: MembershipFixtureDbProof): boolean {
  const lease = proof.lease;
  if (
    BigInt(lease.expires_at_millis) !==
    BigInt(lease.claimed_at_millis) + BigInt(90000)
  )
    return false;
  if (proof.phase === 'LEASE_WAIT')
    return (
      lease.lease_token !== null &&
      lease.successor_checkpoint_version === null &&
      !lease.checkpoint_fenced &&
      !lease.completion_fenced &&
      !lease.failure_fenced
    );
  if (
    lease.successor_checkpoint_version === null ||
    BigInt(lease.successor_checkpoint_version) <=
      BigInt(lease.checkpoint_version)
  )
    return false;
  if (proof.phase === 'LEASE_REPLAY')
    return (
      lease.lease_token !== null &&
      !lease.checkpoint_fenced &&
      !lease.completion_fenced &&
      !lease.failure_fenced
    );
  return (
    lease.lease_token === null &&
    lease.checkpoint_fenced &&
    lease.completion_fenced &&
    lease.failure_fenced
  );
}

function validGc(proof: MembershipFixtureDbProof): boolean {
  const gc = proof.gc;
  if (['LEASE_WAIT', 'LEASE_REPLAY', 'EMPTY_SETTLE'].includes(proof.phase))
    return gc === null;
  if (!gc) return false;
  if (proof.phase === 'GC_OVERLAP' || proof.phase === 'INTERRUPTED')
    return (
      gc.new_run_id === null &&
      gc.reader_verified_at_millis === null &&
      gc.reader_connection_id === null &&
      gc.writer_connection_id === null &&
      gc.retired_at_millis === null &&
      gc.eligible_at_millis === null &&
      gc.deleted_count === 0
    );
  return (
    gc.new_run_id !== null &&
    gc.new_run_id !== gc.old_run_id &&
    gc.reader_connection_id !== null &&
    gc.writer_connection_id !== null &&
    gc.reader_connection_id !== gc.writer_connection_id &&
    gc.reader_verified_at_millis !== null &&
    gc.retired_at_millis !== null &&
    gc.eligible_at_millis !== null &&
    BigInt(gc.eligible_at_millis) ===
      BigInt(gc.retired_at_millis) + BigInt(120000) &&
    BigInt(gc.reader_verified_at_millis) >= BigInt(gc.retired_at_millis) &&
    BigInt(gc.reader_verified_at_millis) < BigInt(gc.eligible_at_millis) &&
    gc.deleted_count <= gc.member_count
  );
}

export const membershipFixtureDbProofSchema = proofShape.refine(
  (proof) =>
    validLease(proof) &&
    validGc(proof) &&
    (proof.phase === 'INTERRUPTED') === (proof.interruption !== null) &&
    (proof.phase === 'DONE') === (proof.completed_at_millis !== null) &&
    (proof.phase !== 'DONE' ||
      proof.gc?.deleted_count === proof.gc?.member_count),
  'Inconsistent membership database proof stage'
);

export type MembershipFixtureDbProofReport = Omit<
  MembershipFixtureDbProof,
  'owner' | 'lease'
> & {
  evidence_kind: 'DATABASE_ONLY';
  lease: Omit<MembershipFixtureDbProof['lease'], 'lease_token'>;
};

export function membershipFixtureDbProofReport(
  proof: MembershipFixtureDbProof
): MembershipFixtureDbProofReport {
  return {
    protocol_version: proof.protocol_version,
    phase: proof.phase,
    gc: proof.gc,
    completed_at_millis: proof.completed_at_millis,
    interruption: proof.interruption,
    evidence_kind: 'DATABASE_ONLY',
    lease: {
      run_id: proof.lease.run_id,
      checkpoint_version: proof.lease.checkpoint_version,
      claimed_at_millis: proof.lease.claimed_at_millis,
      expires_at_millis: proof.lease.expires_at_millis,
      request_version: proof.lease.request_version,
      successor_checkpoint_version: proof.lease.successor_checkpoint_version,
      checkpoint_fenced: proof.lease.checkpoint_fenced,
      completion_fenced: proof.lease.completion_fenced,
      failure_fenced: proof.lease.failure_fenced
    }
  };
}
