import {
  mapWaveToApiWaveMin,
  WaveMinSource
} from '@/api/waves/wave-min.helpers';

describe('mapWaveToApiWaveMin', () => {
  function wave(overrides: Partial<WaveMinSource> = {}): WaveMinSource {
    return {
      id: 'wave-1',
      name: 'Wave 1',
      picture: null,
      description_drop_id: 'description-drop',
      created_by: 'creator',
      last_drop_time: 0,
      submission_type: null,
      chat_enabled: true,
      chat_group_id: null,
      voting_group_id: null,
      participation_group_id: null,
      admin_group_id: null,
      voting_credit_type: 'TDH',
      voting_period_start: null,
      voting_period_end: null,
      visibility_group_id: null,
      admin_drop_deletion_enabled: false,
      forbid_negative_votes: false,
      ...overrides
    };
  }

  it('sets authenticated_user_admin when the authenticated user created the wave', () => {
    const mapped = mapWaveToApiWaveMin({
      wave: wave(),
      displayByWaveId: {},
      groupIdsUserIsEligibleFor: [],
      noRightToVote: false,
      noRightToParticipate: false,
      pinned: false,
      identityWave: false,
      authenticatedProfileId: 'creator'
    });

    expect(mapped.authenticated_user_admin).toBe(true);
  });
});
