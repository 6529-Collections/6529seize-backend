import { LaunchAction, LaunchRecord } from '@/drop-forge/drop-forge.types';
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
  message: string
): void {
  action.attempt_count = (action.attempt_count ?? 0) + 1;
  action.attempt_error = message;
  action.retry_at = now + 60;
  addLaunchEvent(
    record,
    `Claim #${record.data.claim_id}: ${actionDescription(record, action)} attempt ${action.attempt_count} failed (${action.id}): ${message}`,
    true
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

// Array order is the order within each phase group. Expired or unsuccessful
// actions remain outstanding without owning the next group's schedule.
export function dueActions(record: LaunchRecord, now: number): LaunchAction[] {
  return record.data.actions.filter(
    (action) => action.state !== 'CONFIRMED' && action.due <= now
  );
}
