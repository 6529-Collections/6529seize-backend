export const HOLDINGS_KEY_SWEEP_ACTION = 'holdings-key-sweep';

export interface HoldingsKeySweepAction {
  readonly action: typeof HOLDINGS_KEY_SWEEP_ACTION;
  /** Queue the mismatched wallets; without it the sweep only reports. */
  readonly repair: boolean;
}

/**
 * Reads a direct invocation of ownersBalancesLoop that asks for the key
 * sweep: `{ "action": "holdings-key-sweep", "repair": true }`. Returns null
 * for a scheduled or ordinary invocation and throws on a malformed one.
 */
export function readHoldingsKeySweepAction(
  event: unknown
): HoldingsKeySweepAction | null {
  if (
    !event ||
    typeof event !== 'object' ||
    !Object.prototype.hasOwnProperty.call(event, 'action')
  ) {
    return null;
  }
  const input = event as { action: unknown; repair?: unknown };
  if (input.action !== HOLDINGS_KEY_SWEEP_ACTION) {
    throw new Error(
      `Unsupported ownersBalancesLoop action: ${JSON.stringify(input.action)}`
    );
  }
  if (input.repair !== undefined && typeof input.repair !== 'boolean') {
    throw new Error('repair must be true or false');
  }
  return { action: HOLDINGS_KEY_SWEEP_ACTION, repair: input.repair === true };
}
