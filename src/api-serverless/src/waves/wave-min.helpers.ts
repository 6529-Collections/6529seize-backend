import { AuthenticationContext } from '@/auth-context';
import { ApiWaveMin } from '@/api/generated/models/ApiWaveMin';
import { ApiWaveCreditType as WaveCreditTypeApi } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveParticipationSubmissionStrategyType } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategyType';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { enums } from '@/enums';
import {
  resolveWavePictureOverride,
  WaveDisplayOverride
} from '@/api/waves/direct-message-wave-display.service';

export type WaveMinSource = {
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

export function resolveWaveSubmissionType(
  submissionType?: string | null
): ApiWaveParticipationSubmissionStrategyType | null {
  return submissionType
    ? (enums.resolve(
        ApiWaveParticipationSubmissionStrategyType,
        submissionType
      ) ?? null)
    : null;
}

export function getWaveMinPermissionMask(
  authenticationContext?: AuthenticationContext
): {
  noRightToVote: boolean;
  noRightToParticipate: boolean;
} {
  return {
    noRightToVote: !authenticationContext?.hasRightsTo(
      ProfileProxyActionType.RATE_WAVE_DROP
    ),
    noRightToParticipate: !authenticationContext?.hasRightsTo(
      ProfileProxyActionType.CREATE_DROP_TO_WAVE
    )
  };
}

export function mapWaveToApiWaveMin({
  wave,
  displayByWaveId,
  groupIdsUserIsEligibleFor,
  noRightToVote,
  noRightToParticipate,
  pinned,
  identityWave
}: {
  wave: WaveMinSource;
  displayByWaveId: Record<string, WaveDisplayOverride>;
  groupIdsUserIsEligibleFor: string[];
  noRightToVote: boolean;
  noRightToParticipate: boolean;
  pinned: boolean;
  identityWave: boolean;
}): ApiWaveMin {
  return {
    id: wave.id,
    name: displayByWaveId[wave.id]?.name ?? wave.name,
    picture: resolveWavePictureOverride(wave.picture, displayByWaveId[wave.id]),
    description_drop_id: wave.description_drop_id,
    last_drop_time: wave.last_drop_time,
    submission_type: resolveWaveSubmissionType(wave.submission_type),
    authenticated_user_eligible_to_vote:
      !noRightToVote &&
      (wave.voting_group_id === null ||
        groupIdsUserIsEligibleFor.includes(wave.voting_group_id)),
    authenticated_user_eligible_to_participate:
      !noRightToParticipate &&
      (wave.participation_group_id === null ||
        groupIdsUserIsEligibleFor.includes(wave.participation_group_id)),
    authenticated_user_eligible_to_chat:
      wave.chat_enabled &&
      (wave.chat_group_id === null ||
        groupIdsUserIsEligibleFor.includes(wave.chat_group_id)),
    authenticated_user_admin:
      wave.admin_group_id !== null &&
      groupIdsUserIsEligibleFor.includes(wave.admin_group_id),
    voting_period_start: wave.voting_period_start,
    voting_period_end: wave.voting_period_end,
    voting_credit_type: enums.resolveOrThrow(
      WaveCreditTypeApi,
      wave.voting_credit_type
    ),
    visibility_group_id: wave.visibility_group_id,
    participation_group_id: wave.participation_group_id,
    admin_group_id: wave.admin_group_id,
    chat_group_id: wave.chat_group_id,
    voting_group_id: wave.voting_group_id,
    admin_drop_deletion_enabled: wave.admin_drop_deletion_enabled,
    forbid_negative_votes: wave.forbid_negative_votes,
    pinned,
    identity_wave: identityWave
  };
}
