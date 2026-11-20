import type { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import { launchGroup } from '@/drop-forge/drop-forge.groups';
import { launchPreparationSeconds } from '@/drop-forge/drop-forge.plan';
import {
  LaunchAction,
  LaunchRecord,
  WalletBlockReason,
  isLaunchActionSettled
} from '@/drop-forge/drop-forge.types';

export function latestWalletRetry(
  record: LaunchRecord,
  action: LaunchAction,
  config: Pick<DropForgeConfig, 'confirmations'>
): number {
  const group = launchGroup(action);
  const outstanding = record.data.actions.filter(
    (candidate) =>
      launchGroup(candidate) === group && !isLaunchActionSettled(candidate)
  );
  return (
    Math.min(...outstanding.map((candidate) => candidate.deadline)) -
    launchPreparationSeconds(config, outstanding.length)
  );
}

export function recordWalletBlock(
  record: LaunchRecord,
  action: LaunchAction,
  config: DropForgeConfig,
  reason: WalletBlockReason,
  now: number
): number | null {
  const group = launchGroup(action);
  const blocks = (record.data.wallet_blocks ??= {});
  const attempts = Math.min((blocks[group]?.attempts ?? 0) + 1, 2);
  const latest = latestWalletRetry(record, action, config);
  // Leave a full minute for the operator before making a distinct final attempt.
  const retry_at = attempts === 1 && latest > now + 60 ? latest : null;
  blocks[group] = { reason, attempts, retry_at };
  return retry_at;
}

export function canRetryWalletBlock(
  record: LaunchRecord,
  action: LaunchAction,
  config: Pick<DropForgeConfig, 'confirmations'>,
  now: number
): boolean {
  return (
    ['ARMED', 'RUNNING'].includes(record.state) &&
    ['PENDING', 'SIGNED'].includes(action.state) &&
    action.due <= now &&
    !!record.data.wallet_blocks?.[launchGroup(action)] &&
    latestWalletRetry(record, action, config) + 60 > now
  );
}
