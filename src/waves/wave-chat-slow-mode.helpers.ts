import { WaveEntity } from '@/entities/IWave';
import { Time } from '@/time';
import { isWaveCreatorOrAdmin } from '@/waves/wave-admin.helpers';
import { canReplyInWaveChat } from '@/waves/wave-chat-replies.helpers';

export function isWaveChatSlowModeActive(
  wave: Pick<WaveEntity, 'chat_slow_mode_cooldown_ms'>
): boolean {
  return (
    wave.chat_slow_mode_cooldown_ms !== null &&
    wave.chat_slow_mode_cooldown_ms > 0
  );
}

export function isWaveChatSlowModeExempt({
  authenticatedProfileId,
  wave,
  groupIdsUserIsEligibleFor
}: {
  authenticatedProfileId: string | null | undefined;
  wave: Pick<WaveEntity, 'created_by' | 'admin_group_id'>;
  groupIdsUserIsEligibleFor: readonly string[];
}): boolean {
  return isWaveCreatorOrAdmin({
    authenticatedProfileId,
    wave,
    groupIdsUserIsEligibleFor
  });
}

export function resolveNextDropAllowed({
  wave,
  authenticatedProfileId,
  groupIdsUserIsEligibleFor,
  nextDropTimestamp,
  now = Time.currentMillis()
}: {
  wave: Pick<
    WaveEntity,
    | 'chat_enabled'
    | 'chat_group_id'
    | 'chat_replies_open'
    | 'created_by'
    | 'admin_group_id'
    | 'chat_slow_mode_cooldown_ms'
  >;
  authenticatedProfileId: string | null | undefined;
  groupIdsUserIsEligibleFor: readonly string[];
  nextDropTimestamp: number | null | undefined;
  now?: number;
}): number | undefined {
  if (
    !authenticatedProfileId ||
    !isWaveChatSlowModeActive(wave) ||
    // Open repliers outside the chat group are still subject to slow mode.
    !canReplyInWaveChat({ wave, groupIdsUserIsEligibleFor }) ||
    isWaveChatSlowModeExempt({
      authenticatedProfileId,
      wave,
      groupIdsUserIsEligibleFor
    })
  ) {
    return undefined;
  }

  const timestamp = nextDropTimestamp ?? null;
  return timestamp !== null && timestamp > now ? timestamp : undefined;
}
