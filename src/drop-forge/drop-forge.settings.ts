import {
  DROP_FORGE_SETTINGS_TABLE,
  DROP_FORGE_LAUNCHES_TABLE
} from '@/constants';
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
    pay_artist_enabled: !!row?.pay_artist_enabled,
    updated_by: row?.updated_by ?? null,
    updated_at: Number(row?.updated_at ?? 0)
  };
}

export async function updateForgeSettings(
  config: DropForgeConfig,
  wallet: string,
  input: {
    revision: number;
    automation_enabled: boolean;
    pay_artist_enabled: boolean;
  }
): Promise<void> {
  if (
    input.pay_artist_enabled &&
    (!config.maxArtistPayment || config.maxArtistPayment <= BigInt(0))
  )
    throw new LaunchSafetyError(
      'Configure a positive artist payment limit before enabling automatic payments'
    );
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    const ctx = { connection };
    const current = await readForgeSettings(config, ctx, true);
    if (current.revision !== input.revision)
      throw new LaunchRevisionConflict(
        'Launch settings changed; refresh before saving'
      );
    await sqlExecutor.execute(
      `UPDATE ${DROP_FORGE_SETTINGS_TABLE} SET revision = revision + 1, automation_enabled = :automation_enabled, pay_artist_enabled = :pay_artist_enabled, updated_by = :wallet, updated_at = :now WHERE id = :id`,
      { ...input, wallet, now: Date.now(), id: current.id },
      { wrappedConnection: connection }
    );
    const records = await sqlExecutor.execute<{ id: string; revision: number }>(
      `SELECT id, revision FROM ${DROP_FORGE_LAUNCHES_TABLE} WHERE state IN ('ARMED', 'RUNNING') AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.contract')) = :contract AND JSON_EXTRACT(data, '$.chain_id') = :chain AND EXISTS (SELECT 1 FROM JSON_TABLE(data, '$.actions[*]' COLUMNS (action_state VARCHAR(16) PATH '$.state', deadline BIGINT PATH '$.deadline')) pending_actions WHERE pending_actions.action_state IN ('PENDING', 'RESERVED', 'SIGNED') AND (pending_actions.deadline > :now OR pending_actions.action_state = 'SIGNED'))`,
      {
        contract: config.creator,
        chain: config.chainId,
        now: Math.floor(Date.now() / 1000)
      },
      { wrappedConnection: connection }
    );
    for (const record of records)
      await wakeDropForge({ id: record.id, revision: Number(record.revision) });
  });
}

export function disabledActionReason(
  settings: DropForgeSettingsEntity,
  action: LaunchAction
): string | null {
  if (!settings.automation_enabled) return 'launch automation disabled';
  return action.kind === 'PAY_ARTIST' && !settings.pay_artist_enabled
    ? 'automatic artist payment disabled'
    : null;
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
