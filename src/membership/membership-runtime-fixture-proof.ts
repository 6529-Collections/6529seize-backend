import { z } from 'zod';
import { normalizeCounter } from './membership-validation';
import { MEMBERSHIP_FIXTURE_PROFILES } from './membership-runtime-policy';
import { membershipFixtureDbProofSchema } from './membership-runtime-fixture-db-proof.types';

export const fixtureCounter = z.string().refine((value) => {
  try {
    return normalizeCounter(value) === value;
  } catch {
    return false;
  }
});
const uuid = z.string().uuid();
const observed = fixtureCounter.nullable();
const sourceChange = z
  .object({
    run_id: uuid,
    previous_publication_run_id: uuid,
    requested_version: fixtureCounter,
    superseded_observed_at_millis: observed
  })
  .strict();
const capturedBoundary = z
  .object({
    run_id: uuid,
    request_version: fixtureCounter,
    checkpoint_version: fixtureCounter,
    evaluation_time_millis: fixtureCounter,
    valid_until_millis: fixtureCounter,
    superseded_observed_at_millis: observed
  })
  .strict();
const boundary = z
  .object({
    boundary_millis: fixtureCounter,
    full_request_version: fixtureCounter,
    grants_version: fixtureCounter,
    captured: capturedBoundary.nullable(),
    false_publication_run_id: uuid.nullable()
  })
  .strict();
const retryObservation = z
  .object({
    attempts: z.number().int().min(1).max(3),
    observed_at_millis: fixtureCounter,
    available_at_millis: observed
  })
  .strict();
const identityRetry = z
  .object({
    requested_version: fixtureCounter,
    previous_publication_run_id: uuid,
    peer_requested_version: fixtureCounter,
    observations: z.array(retryObservation).max(3),
    parked_observed_at_millis: observed
  })
  .strict();
const fanout = z
  .object({
    request_version: fixtureCounter,
    captured: z
      .object({
        run_id: uuid,
        checkpoint_version: fixtureCounter,
        through_id: z.literal(MEMBERSHIP_FIXTURE_PROFILES[0]),
        after_id: z.literal(MEMBERSHIP_FIXTURE_PROFILES[2]),
        restored_profile_request_version: fixtureCounter,
        completed_observed_at_millis: observed
      })
      .strict()
      .nullable()
  })
  .strict();

/** Fixed scenario receipts, never an event-selected workflow or authority token. */
export const fixtureProofSchema = z
  .object({
    protocol_version: z.literal(1),
    source_change: sourceChange.optional(),
    boundary: boundary.optional(),
    identity_retry: identityRetry.optional(),
    fanout: fanout.optional(),
    db_runtime: membershipFixtureDbProofSchema.optional()
  })
  .strict();
export type FixtureProof = z.infer<typeof fixtureProofSchema>;

function validateBoundary(proof: FixtureProof): void {
  const horizon = proof.boundary;
  const captured = horizon?.captured;
  if (
    captured &&
    (captured.valid_until_millis !== horizon!.boundary_millis ||
      BigInt(captured.evaluation_time_millis) >=
        BigInt(captured.valid_until_millis) ||
      captured.checkpoint_version === '0')
  )
    throw new Error('Invalid fixture captured boundary');
  if (
    horizon?.false_publication_run_id &&
    (!captured?.superseded_observed_at_millis ||
      captured.run_id === horizon.false_publication_run_id)
  )
    throw new Error('Invalid fixture boundary publication proof');
  if (
    captured?.superseded_observed_at_millis &&
    BigInt(captured.superseded_observed_at_millis) <
      BigInt(captured.valid_until_millis)
  )
    throw new Error('Fixture boundary supersession precedes its horizon');
}
function validateRetry(proof: FixtureProof): void {
  const retry = proof.identity_retry;
  let previous = 0;
  for (const entry of retry?.observations ?? []) {
    if (
      entry.attempts <= previous ||
      (entry.attempts === 3) !== (entry.available_at_millis === null) ||
      (entry.available_at_millis !== null &&
        BigInt(entry.available_at_millis) <= BigInt(entry.observed_at_millis))
    )
      throw new Error('Invalid fixture retry observation');
    previous = entry.attempts;
  }
  if (retry?.parked_observed_at_millis && previous !== 3)
    throw new Error('Invalid fixture parked proof');
  if (proof.fanout && !retry?.parked_observed_at_millis)
    throw new Error('Fanout proof requires observed identity park');
  if (
    proof.fanout?.captured &&
    BigInt(proof.fanout.captured.restored_profile_request_version) <=
      BigInt(retry!.requested_version)
  )
    throw new Error('Fixture restored identity requires its own newer request');
}
export function validateFixtureProof(proof: FixtureProof): void {
  validateBoundary(proof);
  validateRetry(proof);
}
