import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  ActiveInputV1,
  MembershipProfileEvaluationSeed
} from '@/membership/membership-evaluator.types';
import { MembershipEvaluationError } from '@/membership/membership-evaluator.types';
import { normalizeCounter } from '@/membership/membership-validation';

export const MEMBERSHIP_INPUT_STATE_MAX_BYTES = 32768;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => Buffer.byteLength(s) <= max * 4);
const id = text(200).refine((s) => /^[A-Za-z0-9_-]+$/.test(s));
const counter = z.string().refine((s) => {
  try {
    return normalizeCounter(s) === s;
  } catch {
    return false;
  }
});
const signed = z
  .string()
  .regex(/^(0|-?[1-9]\d{0,38})$/)
  .refine(
    (s) =>
      BigInt(s) >= -(BigInt(1) << BigInt(127)) &&
      BigInt(s) < BigInt(1) << BigInt(127)
  );
const token = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((s) => BigInt(s) <= BigInt('18446744073709551615'));
const wallet = z.object({ after_wallet: text(50).nullable() }).strict();
const slot = z.number().int().min(0).max(3);
const stage = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('LISTS'),
      after_list_id: text(50).nullable(),
      included: z.boolean(),
      excluded: z.boolean()
    })
    .strict(),
  z.object({ kind: z.literal('SCALARS') }).strict(),
  z
    .object({
      kind: z.literal('RATING'),
      axis: z.enum(['CIC', 'REP']),
      after: z
        .object({
          category: text(100).nullable(),
          other_profile_id: text(50).nullable()
        })
        .strict(),
      signed_sum: signed,
      matching_count: counter
    })
    .strict(),
  z
    .object({
      kind: z.literal('NFT_REQUIREMENT'),
      contract_slot: slot,
      next_json_index: counter,
      current_token: z
        .string()
        .regex(/^(0|-?[1-9]\d{0,18})$/)
        .refine(
          (s) =>
            BigInt(s) >= BigInt('-9223372036854775808') &&
            BigInt(s) <= BigInt('9223372036854775807')
        )
        .nullable(),
      after_owner_wallet: text(50).nullable()
    })
    .strict(),
  z
    .object({
      kind: z.literal('NFT_ANY'),
      contract_slot: slot,
      wallets: wallet
    })
    .strict(),
  z
    .object({
      kind: z.literal('GRANT_INCLUDE'),
      after_token_id: token.nullable(),
      selected_count: counter,
      owned_count: counter
    })
    .strict(),
  z.object({ kind: z.literal('GRANT_ALL_ANY'), wallets: wallet }).strict()
]);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const active = z
  .object({
    protocol_version: z.literal(1),
    seed_fingerprint: fingerprint,
    group_id: id,
    group_version: counter,
    scalar_plan_fingerprint: fingerprint,
    grant_metadata_fingerprint: fingerprint.nullable(),
    valid_until_millis: counter.nullable(),
    stage: stage.refine((s) => {
      if (s.kind === 'RATING')
        return (
          (s.after.category === null) === (s.after.other_profile_id === null) &&
          (s.matching_count !== '0' || s.signed_sum === '0')
        );
      if (s.kind === 'GRANT_INCLUDE')
        return (
          BigInt(s.owned_count) <= BigInt(s.selected_count) &&
          (s.after_token_id !== null ||
            (s.selected_count === '0' && s.owned_count === '0'))
        );
      if (s.kind === 'NFT_REQUIREMENT')
        return s.current_token !== null || s.after_owner_wallet === null;
      return true;
    })
  })
  .strict();
export function validateMembershipActiveInput(value: unknown): ActiveInputV1 {
  if (
    Buffer.byteLength(JSON.stringify(value) ?? '') >
    MEMBERSHIP_INPUT_STATE_MAX_BYTES
  )
    throw new MembershipEvaluationError(
      'INVALID_INPUT',
      'Membership continuation exceeds byte limit'
    );
  const result = active.safeParse(value);
  if (!result.success)
    throw new MembershipEvaluationError(
      'INVALID_INPUT',
      'Invalid membership continuation'
    );
  return result.data;
}
export function membershipFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function membershipSeedFingerprint(
  seed: MembershipProfileEvaluationSeed
): string {
  return membershipFingerprint([
    seed.profile_id,
    seed.identity_consolidation_key,
    seed.spec_version,
    seed.source_versions,
    seed.catalog_version,
    seed.evaluation_time_millis,
    seed.through_group_id
  ]);
}
export function membershipInteger(value: unknown): number {
  if (
    typeof value !== 'number' &&
    typeof value !== 'string' &&
    typeof value !== 'bigint'
  )
    throw new MembershipEvaluationError('INTEGRITY', 'Invalid integer input');
  if (!/^-?\d+$/.test(value.toString()))
    throw new MembershipEvaluationError('INTEGRITY', 'Invalid integer input');
  const n = Number(value);
  if (!Number.isSafeInteger(n))
    throw new MembershipEvaluationError(
      'NUMERIC_DOMAIN_UNSUPPORTED',
      'Membership integer exceeds exact numeric domain'
    );
  return n;
}
export function minimumMembershipHorizon(
  a: string | null,
  b: string | null
): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return BigInt(a) < BigInt(b) ? a : b;
}

export function membershipTruth(value: unknown): boolean {
  if (value === null || value === 0 || value === false || value === '0')
    return false;
  if (value === 1 || value === true || value === '1') return true;
  throw new MembershipEvaluationError(
    'INTEGRITY',
    'Invalid membership boolean input'
  );
}
