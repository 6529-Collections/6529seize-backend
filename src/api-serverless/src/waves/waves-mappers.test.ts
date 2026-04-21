import { aWave } from '@/tests/fixtures/wave.fixture';
import { WavesMappers } from '@/api/waves/waves.mappers';
import { WaveType } from '@/entities/IWave';

describe('WavesMappers', () => {
  it('maps approve decision counts and closed-state eligibility', () => {
    const mapper = new WavesMappers({} as any, {} as any, {} as any, {} as any);
    const waveEntity = {
      ...aWave(
        {
          type: WaveType.APPROVE,
          winning_min_threshold: 10,
          max_winners: 2
        },
        {
          id: 'wave-1',
          name: 'Wave 1',
          serial_no: 1
        }
      ),
      participation_required_metadata: [],
      participation_required_media: []
    };

    const mapped = (mapper as any).mapWaveEntityToApiWave({
      waveEntity,
      relatedData: {
        contributors: {},
        profiles: {
          [waveEntity.created_by]: { id: waveEntity.created_by } as any
        },
        curations: {},
        displayByWaveId: {},
        creationDrops: {
          [waveEntity.description_drop_id]: {
            id: waveEntity.description_drop_id
          }
        },
        subscribedActions: {},
        metrics: {
          'wave-1': {
            wave_id: 'wave-1',
            drops_count: 0,
            subscribers_count: 0,
            participatory_drops_count: 0,
            latest_drop_timestamp: 0
          }
        },
        authenticatedUserMetrics: {},
        authenticatedUserReaderMetrics: {},
        yourParticipationDropsCountByWaveId: {},
        yourUnreadDropsCountByWaveId: {},
        firstUnreadDropSerialNoByWaveId: {},
        wavePauses: {},
        decisionsDoneByWaveId: { 'wave-1': 2 },
        pinnedWaveIds: new Set<string>(),
        identityWaveIds: new Set<string>(),
        authenticatedUserId: waveEntity.created_by
      },
      noRightToVote: false,
      groupIdsUserIsEligibleFor: [],
      noRightToParticipate: false
    });

    expect(mapped.wave.winning_threshold).toBe(10);
    expect(mapped.wave.total_no_of_decisions).toBe(2);
    expect(mapped.wave.no_of_decisions_done).toBe(2);
    expect(mapped.wave.no_of_decisions_left).toBe(0);
    expect(mapped.voting.authenticated_user_eligible).toBe(false);
    expect(mapped.participation.authenticated_user_eligible).toBe(false);
    expect(mapped.chat.authenticated_user_eligible).toBe(true);
  });
});
