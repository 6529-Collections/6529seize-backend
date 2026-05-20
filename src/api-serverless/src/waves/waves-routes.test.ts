jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));

import { ApiCreateNewWave } from '../generated/models/ApiCreateNewWave';
import { ApiUpdateWaveRequest } from '../generated/models/ApiUpdateWaveRequest';
import { ApiWaveCreditType } from '../generated/models/ApiWaveCreditType';
import { ApiWaveType } from '../generated/models/ApiWaveType';
import {
  CreateWaveDecisionsStrategySchema,
  UpdateWaveSchema
} from './waves.routes';
import { Time } from '@/time';

describe('waves route validation', () => {
  const emptyPeriod = { min: null, max: null };

  function updateWaveRequest(firstDecisionTime: number): ApiUpdateWaveRequest {
    return {
      name: 'updated-wave',
      picture: null,
      voting: {
        scope: { group_id: null },
        credit_type: ApiWaveCreditType.Tdh,
        credit_category: null,
        creditor_id: null,
        signature_required: false,
        period: emptyPeriod,
        forbid_negative_votes: false
      },
      visibility: {
        scope: { group_id: null }
      },
      participation: {
        scope: { group_id: null },
        no_of_applications_allowed_per_participant: null,
        required_metadata: [],
        required_media: [],
        signature_required: false,
        period: emptyPeriod,
        terms: null
      },
      chat: {
        scope: { group_id: null },
        enabled: true
      },
      wave: {
        type: ApiWaveType.Rank,
        winning_threshold: null,
        max_winners: null,
        max_votes_per_identity_to_drop: null,
        time_lock_ms: null,
        admin_group: { group_id: null },
        decisions_strategy: {
          first_decision_time: firstDecisionTime,
          subsequent_decisions: [],
          is_rolling: false
        },
        admin_drop_deletion_enabled: false
      }
    };
  }

  it('rejects creating a wave with a past first decision time', () => {
    const result = CreateWaveDecisionsStrategySchema.validate({
      first_decision_time: Time.currentMillis() - Time.hours(1).toMillis(),
      subsequent_decisions: [],
      is_rolling: false
    } satisfies ApiCreateNewWave['wave']['decisions_strategy']);

    expect(result.error?.message).toContain(
      'first_decision_time must be in the future'
    );
  });

  it('checks first decision time against validation time', () => {
    const firstDecisionTime = Time.currentMillis() + Time.hours(1).toMillis();
    const currentMillisSpy = jest
      .spyOn(Time, 'currentMillis')
      .mockReturnValue(firstDecisionTime + 1);

    try {
      const result = CreateWaveDecisionsStrategySchema.validate({
        first_decision_time: firstDecisionTime,
        subsequent_decisions: [],
        is_rolling: false
      } satisfies ApiCreateNewWave['wave']['decisions_strategy']);

      expect(result.error?.message).toContain(
        'first_decision_time must be in the future'
      );
    } finally {
      currentMillisSpy.mockRestore();
    }
  });

  it('allows updating a wave with an existing past first decision time', () => {
    const result = UpdateWaveSchema.validate(
      updateWaveRequest(Time.currentMillis() - Time.hours(1).toMillis())
    );

    expect(result.error).toBeUndefined();
  });

  it('accepts chat links disabled setting on wave update', () => {
    const request = updateWaveRequest(Time.currentMillis());
    request.chat.links_disabled = true;

    const result = UpdateWaveSchema.validate(request);

    expect(result.error).toBeUndefined();
    expect(result.value.chat.links_disabled).toBe(true);
  });
});
