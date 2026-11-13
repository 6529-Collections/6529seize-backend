import {
  DROP_FORGE_SETTINGS_TABLE,
  DROP_FORGE_LAUNCHES_TABLE
} from '@/constants';
import { parseEther } from 'ethers';
import { sqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';
import { RequestContext } from '@/request.context';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import {
  LaunchRevisionConflict,
  LaunchSafetyError,
  LaunchRecord,
  LaunchAction
} from '@/drop-forge/drop-forge.types';
import { DropForgeSettingsEntity } from '@/entities/IDropForgeSettings';
import { wakeDropForge } from '@/drop-forge/drop-forge.wake';
import { addLaunchEvent } from '@/drop-forge/drop-forge.repository';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import { actionDescription } from '@/drop-forge/drop-forge.groups';

export const forgeSettingsId = (
  config: Pick<DropForgeConfig, 'chainId' | 'creator'>
) => `${config.chainId}:${config.creator.toLowerCase()}`;

export async function readForgeSettings(
  config: Pick<DropForgeConfig, 'chainId' | 'creator'>,
  ctx: RequestContext = {},
  lock = false
): Promise<DropForgeSettingsEntity> {
  const id = forgeSettingsId(config);
  if (lock) {
    if (!ctx.connection)
      throw new LaunchSafetyError('Settings lock requires a transaction');
    await sqlExecutor.execute(
      `INSERT IGNORE INTO ${DROP_FORGE_SETTINGS_TABLE} (id) VALUES (:id)`,
      { id },
      { wrappedConnection: ctx.connection }
    );
  }
  const row = await sqlExecutor.oneOrNull<DropForgeSettingsEntity>(
    `SELECT * FROM ${DROP_FORGE_SETTINGS_TABLE} WHERE id = :id${lock ? ' FOR UPDATE' : ''}`,
    { id },
    { wrappedConnection: ctx.connection, forcePool: DbPoolName.WRITE }
  );
  return {
    id,
    revision: Number(row?.revision ?? 0),
    automation_enabled: !!row?.automation_enabled,
    preparation_enabled: !!row?.preparation_enabled,
    pay_artist_enabled: !!row?.pay_artist_enabled,
    max_artist_payment_wei: row?.max_artist_payment_wei ?? null,
    updated_by: row?.updated_by ?? null,
    updated_at: Number(row?.updated_at ?? 0)
  };
}

export const artistPaymentLimitPattern = /^(?:\d{1,59}\.\d{1,18}|\d{1,59})$/;

export function artistPaymentLimit(settings: DropForgeSettingsEntity): bigint {
  return BigInt(settings.max_artist_payment_wei ?? 0);
}

export async function updateForgeSettings(
  config: DropForgeConfig,
  wallet: string,
  input: {
    revision: number;
    automation_enabled?: boolean;
    preparation_enabled?: boolean;
    pay_artist_enabled?: boolean;
    max_artist_payment_eth?: string | null;
  }
): Promise<void> {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const ctx = { connection };
    const current = await readForgeSettings(config, ctx, true);
    if (current.revision !== input.revision)
      throw new LaunchRevisionConflict(
        'Launch settings changed; refresh before saving'
      );
    const automation_enabled =
      input.automation_enabled ?? current.automation_enabled;
    const preparation_enabled =
      input.preparation_enabled ?? current.preparation_enabled;
    const pay_artist_enabled =
      input.pay_artist_enabled ?? current.pay_artist_enabled;
    const max_artist_payment_wei =
      input.max_artist_payment_eth === undefined
        ? current.max_artist_payment_wei
        : parseArtistPaymentLimit(input.max_artist_payment_eth);
    const launchChanged =
      automation_enabled !== current.automation_enabled ||
      pay_artist_enabled !== current.pay_artist_enabled ||
      max_artist_payment_wei !== current.max_artist_payment_wei;
    if (
      pay_artist_enabled &&
      !max_artist_payment_wei &&
      ((automation_enabled && !current.automation_enabled) ||
        !current.pay_artist_enabled ||
        input.max_artist_payment_eth !== undefined)
    )
      throw new LaunchSafetyError(
        'Set a positive artist payment limit before enabling automatic payments'
      );
    if (!launchChanged && preparation_enabled === current.preparation_enabled)
      return;
    await sqlExecutor.execute(
      `UPDATE ${DROP_FORGE_SETTINGS_TABLE} SET revision = revision + 1, automation_enabled = :automation_enabled, preparation_enabled = :preparation_enabled, pay_artist_enabled = :pay_artist_enabled, max_artist_payment_wei = :max_artist_payment_wei, updated_by = :wallet, updated_at = :now WHERE id = :id`,
      {
        automation_enabled,
        preparation_enabled,
        pay_artist_enabled,
        max_artist_payment_wei,
        wallet,
        now: Date.now(),
        id: current.id
      },
      { wrappedConnection: connection }
    );
    if (preparation_enabled && !current.preparation_enabled)
      await dropForgeJobsRepository.wakePending(current.revision + 1, ctx);
    if (!launchChanged) return;
    const records = await sqlExecutor.execute<{ id: string; revision: number }>(
      `SELECT id, revision FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE state IN ('ARMED', 'RUNNING') AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.contract')) = :contract AND JSON_EXTRACT(data, '$.chain_id') = :chain AND EXISTS (SELECT 1 FROM JSON_TABLE(data, '$.actions[*]' COLUMNS (action_state VARCHAR(16) PATH '$.state', deadline BIGINT PATH '$.deadline')) pending_actions WHERE pending_actions.action_state IN ('PENDING', 'RESERVED', 'SIGNED') AND (pending_actions.deadline > :now OR pending_actions.action_state = 'SIGNED'))`,
      {
        contract: config.creator,
        chain: config.chainId,
        now: Math.floor(Date.now() / 1000)
      },
      { wrappedConnection: connection }
    );
    await records.reduce(
      (pending, record) =>
        pending.then(() =>
          wakeDropForge({ id: record.id, revision: Number(record.revision) })
        ),
      Promise.resolve()
    );
  });
}

function parseArtistPaymentLimit(eth: string | null): string | null {
  if (eth === null) return null;
  if (!artistPaymentLimitPattern.test(eth))
    throw new LaunchSafetyError(
      'Enter a positive ETH payment limit with no more than 18 decimal places'
    );
  const wei = parseEther(eth);
  if (wei <= BigInt(0))
    throw new LaunchSafetyError('Artist payment limit must be positive');
  return wei.toString();
}

export function disabledActionReason(
  settings: DropForgeSettingsEntity,
  action: LaunchAction
): string | null {
  if (!settings.automation_enabled) return 'launch automation disabled';
  if (action.kind !== 'PAY_ARTIST') return null;
  if (!settings.pay_artist_enabled) return 'automatic artist payment disabled';
  const cap = artistPaymentLimit(settings);
  if (
    cap <= BigInt(0) ||
    (action.payment && BigInt(action.payment.amount_wei) > cap)
  )
    return 'artist payment exceeds the configured payment limit';
  return null;
}

export function recordDisabledAction(
  record: LaunchRecord,
  action: LaunchAction,
  settings: DropForgeSettingsEntity
): boolean {
  const reason = disabledActionReason(settings, action);
  if (!reason) return false;
  if (
    action.disabled_revision !== settings.revision ||
    action.disabled_reason !== reason
  ) {
    action.disabled_revision = settings.revision;
    action.disabled_reason = reason;
    addLaunchEvent(
      record,
      `Claim #${record.data.claim_id}: ${actionDescription(record, action)} skipped: ${reason}.`
    );
  }
  return true;
}
