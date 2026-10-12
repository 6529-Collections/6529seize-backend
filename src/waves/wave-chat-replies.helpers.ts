import { WaveEntity } from '@/entities/IWave';
import { isWaveCreatorOrAdmin } from '@/waves/wave-admin.helpers';

type WaveChatAccessFields = Pick<
  WaveEntity,
  'chat_enabled' | 'chat_group_id' | 'chat_replies_open'
>;

export function isWaveChatGroupMember({
  wave,
  groupIdsUserIsEligibleFor
}: {
  wave: Pick<WaveEntity, 'chat_group_id'>;
  groupIdsUserIsEligibleFor: readonly string[];
}): boolean {
  return (
    wave.chat_group_id === null ||
    groupIdsUserIsEligibleFor.includes(wave.chat_group_id)
  );
}

/**
 * Replies follow the chat group unless the wave opens them to everyone who can
 * view it. Top-level chat drops always require the chat group.
 */
export function canReplyInWaveChat({
  wave,
  groupIdsUserIsEligibleFor
}: {
  wave: WaveChatAccessFields;
  groupIdsUserIsEligibleFor: readonly string[];
}): boolean {
  return (
    wave.chat_enabled &&
    (wave.chat_replies_open ||
      isWaveChatGroupMember({ wave, groupIdsUserIsEligibleFor }))
  );
}

/**
 * Collapsed-reply waves keep replies out of the main feed; curated views are
 * explicit selections and keep every drop.
 */
export function isWaveMainFeedWithoutReplies({
  wave,
  curationId
}: {
  wave: Pick<WaveEntity, 'chat_replies_collapsed'>;
  curationId: string | null | undefined;
}): boolean {
  return wave.chat_replies_collapsed && !curationId;
}

/**
 * Replies in collapsed-reply waves stay in their thread, so they should not
 * ping wave followers who subscribed to every drop.
 */
export function isCollapsedWaveReply({
  wave,
  replyToDropId
}: {
  wave: Pick<WaveEntity, 'chat_replies_collapsed'>;
  replyToDropId: string | null | undefined;
}): boolean {
  return wave.chat_replies_collapsed && !!replyToDropId;
}

/**
 * Waves with open replies let the people who run them moderate replies: the
 * creator, admins and, when chat is limited to a group, everyone in it.
 */
export function canDeleteRepliesInWave({
  wave,
  authenticatedProfileId,
  groupIdsUserIsEligibleFor
}: {
  wave: Pick<
    WaveEntity,
    | 'chat_replies_open'
    | 'chat_group_id'
    | 'created_by'
    | 'admin_group_id'
    | 'visibility_group_id'
  >;
  authenticatedProfileId: string | null | undefined;
  groupIdsUserIsEligibleFor: readonly string[];
}): boolean {
  if (!authenticatedProfileId || !wave.chat_replies_open) {
    return false;
  }
  return (
    isWaveCreatorOrAdmin({
      authenticatedProfileId,
      wave,
      groupIdsUserIsEligibleFor
    }) ||
    (wave.chat_group_id !== null &&
      groupIdsUserIsEligibleFor.includes(wave.chat_group_id))
  );
}
