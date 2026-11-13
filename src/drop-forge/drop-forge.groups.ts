import {
  LaunchAction,
  LaunchRecord,
  SupplyEvidenceError,
  isLaunchActionSettled
} from '@/drop-forge/drop-forge.types';
import { isResearchAirdrop } from '@/drop-forge/drop-forge.research';
import { addLaunchEvent } from '@/drop-forge/drop-forge.repository';

export function launchGroup(action: LaunchAction): string {
  if (action.kind === 'PAY_ARTIST') return 'post-mint';
  if (isResearchAirdrop(action)) return 'post-mint';
  if (action.kind === 'METADATA') return 'metadata';
  return `phase-${action.phase}`;
}

export function actionDescription(
  record: LaunchRecord,
  action: LaunchAction
): string {
  if (action.kind === 'PAY_ARTIST') return 'Pay Artist';
  if (action.label === 'Airdrop - Artist') return 'Artist airdrops';
  if (action.label === 'Airdrop - Team') return 'Team airdrops';
  if (action.label) return action.label;
  if (action.kind === 'INITIALIZE') return 'claim initialization';
  if (action.kind === 'METADATA') return 'Update published metadata';
  return `${record.data.phases[action.phase].name} claim configuration`;
}

export function reportActionFailure(
  record: LaunchRecord,
  action: LaunchAction,
  now: number,
  message: string,
  error?: unknown,
  feeWei?: string
): void {
  action.attempt_count = (action.attempt_count ?? 0) + 1;
  action.attempt_error = message;
  let delay = 60;
  if (error instanceof SupplyEvidenceError) {
    action.supply_evidence = error.evidence;
    action.supply_retry_count = (action.supply_retry_count ?? 0) + 1;
    delay = [60, 300, 900][Math.min(action.supply_retry_count - 1, 2)];
  }
  action.retry_at = now + delay;
  addLaunchEvent(
    record,
    `Claim #${record.data.claim_id}: ${actionDescription(record, action)} attempt ${action.attempt_count} failed (${action.id}): ${message}`,
    true,
    { fee_wei: feeWei }
  );
}

export function reportActionSkip(
  record: LaunchRecord,
  action: LaunchAction
): void {
  delete action.attempt_error;
  delete action.retry_at;
  addLaunchEvent(
    record,
    `Claim #${record.data.claim_id}: Skipped ${actionDescription(record, action)} (${action.id}); already completed, verified on-chain.${action.hash ? ' ' + action.hash : ''}`
  );
}

export function capRankedAirdrop(
  action: LaunchAction,
  remaining: number
): LaunchAction {
  const outstanding = action.remaining_recipients ?? action.recipients;
  const recipients: LaunchAction['recipients'] = [];
  let available = remaining;
  let unfilled = 0;
  for (const row of outstanding) {
    const amount = Math.min(row.amount, available);
    if (amount > 0) recipients.push({ address: row.address, amount });
    available -= amount;
    unfilled += row.amount - amount;
  }
  return {
    ...action,
    capped_recipients: unfilled ? recipients : undefined,
    unfilled_tokens: unfilled || undefined
  };
}

export function skipSoldOutAction(
  record: LaunchRecord,
  action: LaunchAction
): void {
  action.state = 'SKIPPED';
  delete action.attempt_error;
  delete action.retry_at;
  delete action.disabled_reason;
  if (action.ranked_subscription) {
    const capped = capRankedAirdrop(action, 0);
    action.capped_recipients = capped.capped_recipients;
    action.unfilled_tokens = capped.unfilled_tokens;
  }
  const shortage = action.unfilled_tokens
    ? ` ${action.unfilled_tokens} requested cards went unfilled.`
    : '';
  addLaunchEvent(
    record,
    `Claim #${record.data.claim_id}: Skipped ${actionDescription(record, action)} (${action.id}): Sold out.${shortage}`
  );
}

// Array order is the order within each phase group. Expired or unsuccessful
// actions remain outstanding without owning the next group's schedule.
export function dueActions(record: LaunchRecord, now: number): LaunchAction[] {
  return record.data.actions.filter(
    (action) => !isLaunchActionSettled(action) && action.due <= now
  );
}
