import {
  WaveBaseType,
  WaveIdentitySubmissionDuplicates,
  WaveIdentitySubmissionStrategy,
  WaveSubmissionType
} from '@/entities/IWave';
import { BadRequestException } from '@/exceptions';
import { enums } from '@/enums';
import { ApiWaveParticipationIdentitySubmissionAllowDuplicates } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionAllowDuplicates';
import { ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted } from '@/api/generated/models/ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted';
import { ApiWaveParticipationSubmissionStrategy } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategy';
import { ApiWaveParticipationSubmissionStrategyType } from '@/api/generated/models/ApiWaveParticipationSubmissionStrategyType';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';

type WaveSubmissionStrategyFields = Pick<
  WaveBaseType,
  | 'submission_type'
  | 'identity_submission_strategy'
  | 'identity_submission_duplicates'
>;

function nullWaveSubmissionStrategyFields(): WaveSubmissionStrategyFields {
  return {
    submission_type: null,
    identity_submission_strategy: null,
    identity_submission_duplicates: null
  };
}

export function validateWaveSubmissionStrategy(
  strategy: ApiWaveParticipationSubmissionStrategy | null | undefined,
  waveType?: ApiWaveType
): void {
  if (strategy == null) {
    return;
  }

  if (waveType === ApiWaveType.Chat) {
    throw new BadRequestException(
      `Chat waves can't have a participation submission strategy`
    );
  }

  if (strategy.type !== ApiWaveParticipationSubmissionStrategyType.Identity) {
    throw new BadRequestException(
      `Unsupported submission strategy type ${strategy.type}`
    );
  }

  if (!strategy.config?.duplicates || !strategy.config?.who_can_be_submitted) {
    throw new BadRequestException(
      `Identity submission strategy requires duplicates and who_can_be_submitted`
    );
  }

  if (
    !enums.resolve(WaveIdentitySubmissionDuplicates, strategy.config.duplicates)
  ) {
    throw new BadRequestException(
      `Unsupported identity submission duplicates policy ${strategy.config.duplicates}`
    );
  }

  if (
    !enums.resolve(
      WaveIdentitySubmissionStrategy,
      strategy.config.who_can_be_submitted
    )
  ) {
    throw new BadRequestException(
      `Unsupported identity submission target policy ${strategy.config.who_can_be_submitted}`
    );
  }
}

export function mapApiSubmissionStrategyToWaveFields(
  strategy: ApiWaveParticipationSubmissionStrategy | null | undefined
): WaveSubmissionStrategyFields {
  validateWaveSubmissionStrategy(strategy);

  if (strategy == null) {
    return nullWaveSubmissionStrategyFields();
  }

  return {
    submission_type: WaveSubmissionType.IDENTITY,
    identity_submission_strategy: enums.resolveOrThrow(
      WaveIdentitySubmissionStrategy,
      strategy.config.who_can_be_submitted
    ),
    identity_submission_duplicates: enums.resolveOrThrow(
      WaveIdentitySubmissionDuplicates,
      strategy.config.duplicates
    )
  };
}

export function resolveWaveSubmissionStrategyFieldsForWrite({
  strategy,
  existingStrategy
}: {
  strategy: ApiWaveParticipationSubmissionStrategy | null | undefined;
  existingStrategy?: WaveSubmissionStrategyFields | null;
}): WaveSubmissionStrategyFields {
  if (strategy !== undefined) {
    return mapApiSubmissionStrategyToWaveFields(strategy);
  }

  if (existingStrategy) {
    return {
      submission_type: existingStrategy.submission_type,
      identity_submission_strategy:
        existingStrategy.identity_submission_strategy,
      identity_submission_duplicates:
        existingStrategy.identity_submission_duplicates
    };
  }

  return nullWaveSubmissionStrategyFields();
}

export function mapWaveFieldsToApiSubmissionStrategy(
  wave: WaveSubmissionStrategyFields
): ApiWaveParticipationSubmissionStrategy | null {
  if (
    wave.submission_type !== WaveSubmissionType.IDENTITY ||
    wave.identity_submission_strategy === null ||
    wave.identity_submission_duplicates === null
  ) {
    return null;
  }

  return {
    type: ApiWaveParticipationSubmissionStrategyType.Identity,
    config: {
      duplicates: enums.resolveOrThrow(
        ApiWaveParticipationIdentitySubmissionAllowDuplicates,
        wave.identity_submission_duplicates
      ),
      who_can_be_submitted: enums.resolveOrThrow(
        ApiWaveParticipationIdentitySubmissionWhoCanBeSubmitted,
        wave.identity_submission_strategy
      )
    }
  };
}
