import { ApiWaveCreditType as WaveCreditTypeApi } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveMin } from '@/api/generated/models/ApiWaveMin';
import { ApiWaveParticipationSubmissionStrategyType } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategyType';
import {
  resolveWavePictureOverride,
  WaveDisplayOverride
} from '@/api/waves/direct-message-wave-display.service';
import { enums } from '@/enums';

export type WaveMinMappableEntity = {
  id: string;
  name: string;
  picture: string | null;
  description_drop_id: string;
  last_drop_time: number;
  submission_type: string | null;
  chat_enabled: boolean;
  chat_group_id: string | null;
  voting_group_id: string | null;
  participation_group_id: string | null;
  admin_group_id: string | null;
  voting_credit_type: string;
  voting_period_start: number | null;
  voting_period_end: number | null;
  visibility_group_id: string | null;
  admin_drop_deletion_enabled: boolean;
  forbid_negative_votes: boolean;
};

export function mapWaveEntityToApiWaveMin({
  waveEntity,
  groupIdsUserIsEligibleFor,
  pinned,
  displayOverride,
  noRightToVote = false,
  noRightToParticipate = false
}: {
  waveEntity: WaveMinMappableEntity;
  groupIdsUserIsEligibleFor: string[];
  pinned: boolean;
  displayOverride?: WaveDisplayOverride;
  noRightToVote?: boolean;
  noRightToParticipate?: boolean;
}): ApiWaveMin {
  return {
    id: waveEntity.id,
    name: displayOverride?.name ?? waveEntity.name,
    picture: resolveWavePictureOverride(waveEntity.picture, displayOverride),
    description_drop_id: waveEntity.description_drop_id,
    last_drop_time: waveEntity.last_drop_time,
    submission_type: waveEntity.submission_type
      ? enums.resolveOrThrow(
          ApiWaveParticipationSubmissionStrategyType,
          waveEntity.submission_type
        )
      : null,
    authenticated_user_eligible_to_chat:
      waveEntity.chat_enabled &&
      (waveEntity.chat_group_id === null ||
        groupIdsUserIsEligibleFor.includes(waveEntity.chat_group_id)),
    authenticated_user_eligible_to_vote:
      !noRightToVote &&
      (waveEntity.voting_group_id === null ||
        groupIdsUserIsEligibleFor.includes(waveEntity.voting_group_id)),
    authenticated_user_eligible_to_participate:
      !noRightToParticipate &&
      (waveEntity.participation_group_id === null ||
        groupIdsUserIsEligibleFor.includes(waveEntity.participation_group_id)),
    authenticated_user_admin:
      waveEntity.admin_group_id !== null &&
      groupIdsUserIsEligibleFor.includes(waveEntity.admin_group_id),
    voting_credit_type: enums.resolveOrThrow(
      WaveCreditTypeApi,
      waveEntity.voting_credit_type
    ),
    voting_period_start: waveEntity.voting_period_start,
    voting_period_end: waveEntity.voting_period_end,
    visibility_group_id: waveEntity.visibility_group_id,
    participation_group_id: waveEntity.participation_group_id,
    chat_group_id: waveEntity.chat_group_id,
    voting_group_id: waveEntity.voting_group_id,
    admin_group_id: waveEntity.admin_group_id,
    admin_drop_deletion_enabled: waveEntity.admin_drop_deletion_enabled,
    forbid_negative_votes: waveEntity.forbid_negative_votes,
    pinned
  };
}
