import { env } from './env';
import {
  CONSOLIDATIONS_LIMIT,
  CONSOLIDATIONS_UNGATED_LIMIT
} from './constants';
import type { ApiConsolidationPolicy } from '@/api/generated/models/ApiConsolidationPolicy';

export const CONSOLIDATION_ACTIVATION_ENV =
  'CONSOLIDATION_FOUR_WALLET_ACTIVATION_AT';
const SIGNING_MARGIN_MS = 10 * 60 * 1000;

// The parsed policy for the last configured value. Grouping and every
// settings request read the policy, so it is validated once per value, not
// per call. Keyed by the raw value, so a changed setting is picked up, and a
// missing or invalid one still throws on every call.
let cached: { value: string; policy: ApiConsolidationPolicy } | undefined;

/** Resolve after prepEnvironment, from this environment's regional config. */
export function getConsolidationPolicy(): ApiConsolidationPolicy {
  const value = env.getStringOrThrow(CONSOLIDATION_ACTIVATION_ENV);
  if (cached?.value === value) {
    return cached.policy;
  }
  // Frozen: every caller shares this object.
  const policy = Object.freeze(parseConsolidationPolicy(value));
  cached = { value, policy };
  return policy;
}

function parseConsolidationPolicy(value: string): ApiConsolidationPolicy {
  const activationMs = Date.parse(value);
  const normalized = value.endsWith('.000Z')
    ? value
    : value.replace(/Z$/, '.000Z');
  // The regex only checks the shape. Date silently rolls impossible values
  // over (24:00:00 to the next day, 30 February to March), so the round trip
  // back to the same ISO string is what rejects them. Keep both checks.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value) ||
    !Number.isFinite(activationMs) ||
    new Date(activationMs).toISOString() !== normalized ||
    !Number.isFinite(new Date(activationMs + SIGNING_MARGIN_MS).getTime())
  ) {
    throw new Error(
      `${CONSOLIDATION_ACTIVATION_ENV} must be a valid ISO UTC datetime at whole-second precision`
    );
  }
  return {
    max_wallets: CONSOLIDATIONS_LIMIT,
    ungated_max_wallets: CONSOLIDATIONS_UNGATED_LIMIT,
    four_wallet_activation_at: new Date(activationMs).toISOString(),
    four_wallet_signing_opens_at: new Date(
      activationMs + SIGNING_MARGIN_MS
    ).toISOString()
  };
}
