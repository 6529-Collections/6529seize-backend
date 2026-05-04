import { AuthenticationContext } from '@/auth-context';
import { PageSortDirection } from '@/api/page-request';
import {
  WaveDecisionsApiService,
  WaveDecisionsQuerySort
} from '@/api/waves/wave-decisions-api.service';
import { ApiWaveOutcomeCredit } from '@/api/generated/models/ApiWaveOutcomeCredit';
import { ApiWaveOutcomeSubType } from '@/api/generated/models/ApiWaveOutcomeSubType';
import { ApiWaveOutcomeType } from '@/api/generated/models/ApiWaveOutcomeType';
import {
  WaveOutcomeCredit,
  WaveOutcomeSubType,
  WaveOutcomeType
} from '@/entities/IWave';

describe('WaveDecisionsApiService', () => {
  it('maps V2 decisions with ApiDropV2 drops and omits null award fields', async () => {
    const decision = { wave_id: 'wave-1', decision_time: 1000 };
    const dropEntity = { id: 'drop-1' };
    const waveDecisionsDb = {
      searchForDecisions: jest.fn().mockResolvedValue([decision]),
      countDecisions: jest.fn().mockResolvedValue(1),
      findAllDecisionWinners: jest.fn().mockResolvedValue([
        {
          wave_id: 'wave-1',
          decision_time: 1000,
          drop_id: 'drop-1',
          ranking: 1,
          final_vote: 42,
          prizes: [
            {
              type: WaveOutcomeType.AUTOMATIC,
              subtype: WaveOutcomeSubType.CREDIT_DISTRIBUTION,
              description: 'REP award',
              credit: WaveOutcomeCredit.REP,
              rep_category: 'builder',
              amount: 25
            },
            {
              type: WaveOutcomeType.MANUAL,
              subtype: null,
              description: 'Manual award',
              credit: null,
              rep_category: null,
              amount: null
            }
          ]
        }
      ])
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    };
    const wavesApiDb = {
      findWaveById: jest.fn().mockResolvedValue({
        id: 'wave-1',
        visibility_group_id: null
      })
    };
    const dropsApiService = {};
    const dropsDb = {
      getDropsByIds: jest.fn().mockResolvedValue([dropEntity])
    };
    const apiDropMapper = {
      mapDrops: jest.fn().mockResolvedValue({
        'drop-1': { id: 'drop-1', parts_count: 1 }
      })
    };
    const service = new WaveDecisionsApiService(
      waveDecisionsDb as any,
      userGroupsService as any,
      wavesApiDb as any,
      dropsApiService as any,
      dropsDb as any,
      apiDropMapper as any
    );
    const ctx = {
      authenticationContext: AuthenticationContext.fromProfileId('viewer-1')
    };

    const result = await service.searchConcludedWaveDecisionsV2(
      {
        wave_id: 'wave-1',
        page: 1,
        page_size: 100,
        sort_direction: PageSortDirection.DESC,
        sort: WaveDecisionsQuerySort.decision_time
      },
      ctx
    );

    expect(dropsDb.getDropsByIds).toHaveBeenCalledWith(['drop-1'], undefined);
    expect(apiDropMapper.mapDrops).toHaveBeenCalledWith([dropEntity], ctx);
    expect(result.data[0].winners[0].drop).toEqual({
      id: 'drop-1',
      parts_count: 1
    });
    expect(result.data[0].winners[0].awards).toEqual([
      {
        type: ApiWaveOutcomeType.Automatic,
        subtype: ApiWaveOutcomeSubType.CreditDistribution,
        description: 'REP award',
        credit: ApiWaveOutcomeCredit.Rep,
        rep_category: 'builder',
        amount: 25
      },
      {
        type: ApiWaveOutcomeType.Manual,
        description: 'Manual award'
      }
    ]);
  });
});
