import { getAddress } from 'ethers';
import {
  LaunchAction,
  LaunchData,
  LaunchSafetyError
} from '@/drop-forge/drop-forge.types';

export const RESEARCH_AIRDROP_ADDRESS = getAddress(
  '0xc2ce4ccef11a8171f443745cea3bceeaadd750c7'
);
export const RESEARCH_TARGET_TOTAL = 310;
export const RESEARCH_DELAY_SECONDS = 60 * 60;
export const isResearchAirdrop = (action: LaunchAction): boolean =>
  action.kind === 'AIRDROP' && action.id === 'research-airdrop';

export function researchAirdropAmount(total: number, edition: number): number {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(edition) ||
    edition < 1 ||
    total > edition
  )
    throw new LaunchSafetyError('Invalid research supply or edition maximum');
  return Math.max(0, Math.min(RESEARCH_TARGET_TOTAL, edition) - total);
}

export function assertResearchTiming(
  data: LaunchData,
  action: LaunchAction,
  now: number
): void {
  const last = data.phases.length - 1;
  if (
    action.phase !== last ||
    action.due !== data.phases[last].end + RESEARCH_DELAY_SECONDS ||
    now < action.due
  )
    throw new LaunchSafetyError(
      'Research airdrop is only eligible one hour after the final mint window closes'
    );
}

export function verifyResearchSupply(
  data: LaunchData,
  action: LaunchAction,
  total: number,
  now: number,
  capture: boolean
): void {
  assertResearchTiming(data, action, now);
  const amount = researchAirdropAmount(total, data.edition_size);
  if (capture) {
    if (!amount)
      throw new LaunchSafetyError(
        'Research target is already satisfied; reconcile before resuming'
      );
    action.expected_supply = total;
    action.recipients = [{ address: RESEARCH_AIRDROP_ADDRESS, amount }];
    delete action.remaining_recipients;
  }
  if (action.expected_supply !== total)
    throw new LaunchSafetyError(
      'Claim supply changed before the research transaction'
    );
  const recipients = action.remaining_recipients ?? action.recipients;
  if (
    recipients.length !== 1 ||
    recipients[0].address.toLowerCase() !==
      RESEARCH_AIRDROP_ADDRESS.toLowerCase() ||
    recipients[0].amount !== amount ||
    amount === 0
  )
    throw new LaunchSafetyError(
      'Research transaction differs from the remaining target supply'
    );
}

export function creditManualResearch(
  data: LaunchData,
  allocations: Map<string, number>,
  hash: string
): void {
  const action = data.actions.find(isResearchAirdrop);
  const amount = allocations.get(RESEARCH_AIRDROP_ADDRESS.toLowerCase());
  if (
    !action ||
    (!['PENDING', 'CONFIRMED'].includes(action.state) &&
      !(action.recovery?.outcome && action.recovery.outcome !== 'EXECUTED')) ||
    allocations.size !== 1 ||
    amount === undefined ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > data.edition_size
  )
    throw new LaunchSafetyError(
      'Manual research transaction does not match the pending research action'
    );
  action.credited_tokens = (action.credited_tokens ?? 0) + amount;
  action.manual_hashes = [...(action.manual_hashes ?? []), hash];
  if (action.state === 'CONFIRMED') return;
  if (action.recovery?.outcome) {
    action.recovery_history = [
      ...(action.recovery_history ?? []),
      action.recovery
    ];
    delete action.recovery;
    delete action.signed_tx;
    delete action.hash;
    action.state = 'PENDING';
  }
  // Research has a dynamic top-up quantity. Recompute from canonical total after
  // minting closes rather than crediting this transaction into phase batches.
  action.recipients = [];
  delete action.remaining_recipients;
  delete action.expected_supply;
}
