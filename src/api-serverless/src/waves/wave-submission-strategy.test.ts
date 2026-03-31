import {
  WaveIdentitySubmissionDuplicates,
  WaveIdentitySubmissionStrategy,
  WaveSubmissionType
} from '@/entities/IWave';
import { ApiWaveParticipationIdentitySubmissionAllowDuplicates } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionAllowDuplicates';
import { ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted';
import { ApiWaveParticipationSubmissionStrategyType } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategyType';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import {
  mapApiSubmissionStrategyToWaveFields,
  resolveWaveSubmissionStrategyFieldsForWrite,
  mapWaveFieldsToApiSubmissionStrategy,
  validateWaveSubmissionStrategy
} from './wave-submission-strategy';

describe('wave-submission-strategy', () => {
  it('maps a null API strategy to null wave fields', () => {
    expect(mapApiSubmissionStrategyToWaveFields(null)).toEqual({
      submission_type: null,
      identity_submission_strategy: null,
      identity_submission_duplicates: null
    });
  });

  it('maps an identity API strategy to flat wave fields', () => {
    expect(
      mapApiSubmissionStrategyToWaveFields({
        type: ApiWaveParticipationSubmissionStrategyType.Identity,
        config: {
          duplicates:
            ApiWaveParticipationIdentitySubmissionAllowDuplicates.AllowAfterWin,
          who_can_be_submitted:
            ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.OnlyOthers
        }
      })
    ).toEqual({
      submission_type: WaveSubmissionType.IDENTITY,
      identity_submission_strategy: WaveIdentitySubmissionStrategy.ONLY_OTHERS,
      identity_submission_duplicates:
        WaveIdentitySubmissionDuplicates.ALLOW_AFTER_WIN
    });
  });

  it('maps identity wave fields back to the nested API shape', () => {
    expect(
      mapWaveFieldsToApiSubmissionStrategy({
        submission_type: WaveSubmissionType.IDENTITY,
        identity_submission_strategy:
          WaveIdentitySubmissionStrategy.ONLY_MYSELF,
        identity_submission_duplicates:
          WaveIdentitySubmissionDuplicates.NEVER_ALLOW
      })
    ).toEqual({
      type: ApiWaveParticipationSubmissionStrategyType.Identity,
      config: {
        duplicates:
          ApiWaveParticipationIdentitySubmissionAllowDuplicates.NeverAllow,
        who_can_be_submitted:
          ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.OnlyMyself
      }
    });
  });

  it('returns null for incomplete identity wave fields', () => {
    expect(
      mapWaveFieldsToApiSubmissionStrategy({
        submission_type: WaveSubmissionType.IDENTITY,
        identity_submission_strategy: null,
        identity_submission_duplicates:
          WaveIdentitySubmissionDuplicates.ALWAYS_ALLOW
      })
    ).toBeNull();
  });

  it('rejects malformed identity strategy payloads', () => {
    expect(() =>
      validateWaveSubmissionStrategy({
        type: ApiWaveParticipationSubmissionStrategyType.Identity,
        config: {
          duplicates: undefined as never,
          who_can_be_submitted:
            ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.Everyone
        }
      })
    ).toThrow(
      'Identity submission strategy requires duplicates and who_can_be_submitted'
    );
  });

  it('rejects unknown duplicates enum values with a bad request error', () => {
    expect(() =>
      validateWaveSubmissionStrategy({
        type: ApiWaveParticipationSubmissionStrategyType.Identity,
        config: {
          duplicates: 'NOT_A_REAL_POLICY' as never,
          who_can_be_submitted:
            ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.Everyone
        }
      })
    ).toThrow(
      `Unsupported identity submission duplicates policy NOT_A_REAL_POLICY`
    );
  });

  it('rejects unknown nomination-target enum values with a bad request error', () => {
    expect(() =>
      validateWaveSubmissionStrategy({
        type: ApiWaveParticipationSubmissionStrategyType.Identity,
        config: {
          duplicates:
            ApiWaveParticipationIdentitySubmissionAllowDuplicates.AllowAfterWin,
          who_can_be_submitted: 'NOT_A_REAL_TARGET_POLICY' as never
        }
      })
    ).toThrow(
      `Unsupported identity submission target policy NOT_A_REAL_TARGET_POLICY`
    );
  });

  it('rejects submission strategies on chat waves', () => {
    expect(() =>
      validateWaveSubmissionStrategy(
        {
          type: ApiWaveParticipationSubmissionStrategyType.Identity,
          config: {
            duplicates:
              ApiWaveParticipationIdentitySubmissionAllowDuplicates.AllowAfterWin,
            who_can_be_submitted:
              ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted.Everyone
          }
        },
        ApiWaveType.Chat
      )
    ).toThrow(`Chat waves can't have a participation submission strategy`);
  });

  it('preserves the existing wave strategy when updates omit the field', () => {
    expect(
      resolveWaveSubmissionStrategyFieldsForWrite({
        strategy: undefined,
        existingStrategy: {
          submission_type: WaveSubmissionType.IDENTITY,
          identity_submission_strategy: WaveIdentitySubmissionStrategy.EVERYONE,
          identity_submission_duplicates:
            WaveIdentitySubmissionDuplicates.ALWAYS_ALLOW
        }
      })
    ).toEqual({
      submission_type: WaveSubmissionType.IDENTITY,
      identity_submission_strategy: WaveIdentitySubmissionStrategy.EVERYONE,
      identity_submission_duplicates:
        WaveIdentitySubmissionDuplicates.ALWAYS_ALLOW
    });
  });
});
