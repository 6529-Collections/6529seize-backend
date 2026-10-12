import { env } from './env';
import type { ApiConsolidationPolicy } from '@/api/generated/models/ApiConsolidationPolicy';

export const CONSOLIDATION_ACTIVATION_ENV =
  'CONSOLIDATION_FOUR_WALLET_ACTIVATION_AT';
const SIGNING_MARGIN_MS = 10 * 60 * 1000;

/** Resolve after prepEnvironment, from this environment's regional config. */
export function getConsolidationPolicy(): ApiConsolidationPolicy {
  const value = env.getStringOrThrow(CONSOLIDATION_ACTIVATION_ENV);
  const activationMs = Date.parse(value);
  const normalized = value.endsWith('.000Z')
    ? value
    : value.replace(/Z$/, '.000Z');
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
    four_wallet_activation_at: new Date(activationMs).toISOString(),
    four_wallet_signing_opens_at: new Date(
      activationMs + SIGNING_MARGIN_MS
    ).toISOString()
  };
}
