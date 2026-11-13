import { AuthenticationContext } from '@/auth-context';
import { PageSortDirection } from '@/api/page-request';
import { NotFoundException } from '@/exceptions';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
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

function proxyContext(actions: ProfileProxyActionType[]) {
  return new AuthenticationContext({
    authenticatedWallet: '0xproxy',
    authenticatedProfileId: 'proxy-profile',
    roleProfileId: 'grantor-profile',
    activeProxyActions: actions.map((type, index) => ({
      id: `action-${index}`,
      type,
      credit_amount: null,
      credit_spent: null
    }))
  });
}

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
        sort: WaveDecisionsQuerySort.decision_time,
        is_additional_action_promised: true
      },
      ctx
    );

    expect(waveDecisionsDb.searchForDecisions).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        limit: 100,
        offset: 0,
        sort_direction: PageSortDirection.DESC,
        sort: WaveDecisionsQuerySort.decision_time,
        is_additional_action_promised: true
      },
      ctx
    );
    expect(waveDecisionsDb.countDecisions).toHaveBeenCalledWith(
      {
        wave_id: 'wave-1',
        is_additional_action_promised: true
      },
      ctx
    );
    expect(waveDecisionsDb.findAllDecisionWinners).toHaveBeenCalledWith(
      [decision],
      true,
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

describe('WaveDecisionsApiService proxy read context', () => {
  function createService() {
    const waveDecisionsDb = {
      searchForDecisions: jest.fn().mockResolvedValue([]),
      countDecisions: jest.fn().mockResolvedValue(0),
      findAllDecisionWinners: jest.fn().mockResolvedValue([])
    };
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['private-group'])
    };
    const wavesApiDb = {
      findWaveById: jest.fn().mockResolvedValue({
        id: 'wave-1',
        visibility_group_id: 'private-group',
        parent_wave_id: null
      }),
      findOutcomes: jest.fn().mockResolvedValue([]),
      countOutcomes: jest.fn().mockResolvedValue(0),
      findOutcomeDistributionItems: jest.fn().mockResolvedValue([]),
      countOutcomeDistributionItems: jest.fn().mockResolvedValue(0)
    };
    const service = new WaveDecisionsApiService(
      waveDecisionsDb as any,
      userGroupsService as any,
      wavesApiDb as any,
      {} as any,
      { getDropsByIds: jest.fn().mockResolvedValue([]) } as any,
      { mapDrops: jest.fn().mockResolvedValue({}) } as any
    );
    return { service, waveDecisionsDb, userGroupsService, wavesApiDb };
  }

  const calls: [
    string,
    (service: WaveDecisionsApiService, ctx: any) => Promise<unknown>
  ][] = [
    [
      'searchConcludedWaveDecisionsV2',
      (service, ctx) =>
        service.searchConcludedWaveDecisionsV2(
          {
            wave_id: 'wave-1',
            page: 1,
            page_size: 10,
            sort_direction: PageSortDirection.DESC,
            sort: WaveDecisionsQuerySort.decision_time
          } as any,
          ctx
        )
    ],
    [
      'getOutcomes',
      (service, ctx) =>
        service.getOutcomes(
          {
            wave_id: 'wave-1',
            page: 1,
            page_size: 10,
            sort_direction: PageSortDirection.DESC
          } as any,
          ctx
        )
    ],
    [
      'getOutcomeDistribution',
      (service, ctx) =>
        service.getOutcomeDistribution(
          {
            wave_id: 'wave-1',
            outcome_index: 1,
            page: 1,
            page_size: 10,
            sort_direction: PageSortDirection.DESC
          } as any,
          ctx
        )
    ]
  ];

  it.each(calls)(
    '%s hides a private wave from a proxy without READ_WAVE',
    async (_label, call) => {
      const { service, userGroupsService } = createService();

      await expect(
        call(service, {
          authenticationContext: proxyContext([
            ProfileProxyActionType.CREATE_WAVE
          ])
        })
      ).rejects.toThrow(NotFoundException);
      expect(
        userGroupsService.getGroupsUserIsEligibleFor
      ).not.toHaveBeenCalled();
    }
  );

  it.each(calls)(
    '%s serves a private wave to a proxy with READ_WAVE for a member grantor',
    async (_label, call) => {
      const { service } = createService();

      await expect(
        call(service, {
          authenticationContext: proxyContext([
            ProfileProxyActionType.READ_WAVE
          ])
        })
      ).resolves.toBeDefined();
    }
  );
});
