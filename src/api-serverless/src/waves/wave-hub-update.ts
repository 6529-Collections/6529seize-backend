import { ApiUpdateWaveHubRequest } from '@/api/generated/models/ApiUpdateWaveHubRequest';
import { WaveEntity } from '@/entities/IWave';
import { Time } from '@/time';

function requested<T>(value: T | undefined, current: T): T {
  // Explicit null clears a value; only omission preserves the current setting.
  if (value === undefined) return current;
  return value;
}

export function applyWaveHubPatch<T extends WaveEntity>(
  before: T,
  patch: ApiUpdateWaveHubRequest
): T {
  return {
    ...before,
    name: requested(patch.name, before.name),
    picture: requested(patch.picture, before.picture),
    visibility_group_id: requested(
      patch.visibility?.scope.group_id,
      before.visibility_group_id
    ),
    admin_group_id: requested(
      patch.admin_group?.group_id,
      before.admin_group_id
    ),
    admin_drop_deletion_enabled: requested(
      patch.admin_drop_deletion_enabled,
      before.admin_drop_deletion_enabled
    ),
    chat_group_id: requested(patch.chat?.scope?.group_id, before.chat_group_id),
    chat_enabled: requested(patch.chat?.enabled, before.chat_enabled),
    chat_links_disabled: requested(
      patch.chat?.links_disabled,
      before.chat_links_disabled
    ),
    chat_slow_mode_cooldown_ms: requested(
      patch.chat?.slow_mode_cooldown_ms,
      before.chat_slow_mode_cooldown_ms
    ),
    chat_replies_open: requested(
      patch.chat?.replies?.open,
      before.chat_replies_open
    ),
    chat_replies_collapsed: requested(
      patch.chat?.replies?.collapsed,
      before.chat_replies_collapsed
    ),
    updated_at: Time.currentMillis()
  };
}

export function waveHubAccessChanged(
  before: WaveEntity,
  after: WaveEntity
): boolean {
  return (
    [
      'visibility_group_id',
      'chat_group_id',
      'admin_group_id',
      'chat_enabled'
    ] as const
  ).some((key) => before[key] !== after[key]);
}
