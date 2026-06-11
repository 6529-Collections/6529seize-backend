jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

import { AuthenticationContext } from '@/auth-context';
import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';
import { DropPollsApiService } from '@/api/drops/drop-polls.api.service';
import { DropPollsOrderBy, DropPollState } from '@/api/drops/drop-polls.db';
import { PageSortDirection } from '@/api/page-request';
import { DropType } from '@/entities/IDrop';
import { Time } from '@/time';

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

function createService() {
  const dropPollsDb = {
    createPoll: jest.fn().mockResolvedValue(undefined),
    countWavePolls: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(
      async (callback: (connection: unknown) => Promise<void>) => {
        await callback('tx-connection');
      }
    ),
    findWavePolls: jest.fn(),
    findPollByDropIdForUpdate: jest.fn(),
    findOptionsByPollId: jest.fn(),
    replaceVoterVotes: jest.fn().mockResolvedValue(true)
  };
  const dropsDb = {
    findDropByIdWithEligibilityCheck: jest.fn().mockResolvedValue({
      id: 'drop-1',
      wave_id: 'wave-1',
      author_id: 'author-1'
    })
  };
  const wavesApiDb = {
    findById: jest.fn().mockResolvedValue({
      id: 'wave-1',
      created_by: 'creator-1',
      admin_group_id: 'admin-group',
      visibility_group_id: 'visibility-group'
    }),
    findWaveById: jest.fn().mockResolvedValue({
      id: 'wave-1',
      parent_wave_id: null,
      visibility_group_id: null
    })
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  };
  const identityFetcher = {
    getApiIdentityOverviewsByIds: jest.fn()
  };
  const dropsService = {
    findDropByIdOrThrow: jest.fn().mockResolvedValue({ id: 'drop-1' }),
    findDropsV2ByIds: jest.fn().mockResolvedValue({
      'drop-1': { id: 'drop-1' }
    })
  };
  const wsListenersNotifier = {
    notifyAboutDropUpdate: jest.fn().mockResolvedValue(undefined)
  };
  const userNotifier = {
    notifyOfDropPollVote: jest.fn().mockResolvedValue(undefined)
  };

  return {
    service: new DropPollsApiService(
      dropPollsDb as any,
      dropsDb as any,
      wavesApiDb as any,
      userGroupsService as any,
      identityFetcher as any,
      dropsService as any,
      wsListenersNotifier as any,
      userNotifier as any
    ),
    deps: {
      dropPollsDb,
      dropsDb,
      wavesApiDb,
      userGroupsService,
      dropsService,
      wsListenersNotifier,
      userNotifier
    }
  };
}

describe('DropPollsApiService', () => {
  it('creates polls for wave creators with one-based trimmed options', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);
    const { service, deps } = createService();

    await service.createPollForDrop(
      {
        poll: {
          options: [' First ', 'Second'],
          multichoice: false,
          closing_time: 2_000
        },
        dropId: 'drop-1',
        waveId: 'wave-1',
        authorId: 'creator-1',
        dropType: DropType.CHAT
      },
      {}
    );

    expect(deps.dropPollsDb.createPoll).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        closing_time: 2_000,
        multichoice: false,
        options: [
          { option_no: 1, option_string: 'First' },
          { option_no: 2, option_string: 'Second' }
        ]
      }),
      {}
    );
  });

  it('rejects poll creation by users who are not wave creators or admins', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);
    const { service, deps } = createService();

    await expect(
      service.createPollForDrop(
        {
          poll: {
            options: ['First', 'Second'],
            multichoice: false,
            closing_time: 2_000
          },
          dropId: 'drop-1',
          waveId: 'wave-1',
          authorId: 'other-user',
          dropType: DropType.CHAT
        },
        {}
      )
    ).rejects.toThrow('Only wave creators and admins can create polls');
    expect(deps.dropPollsDb.createPoll).not.toHaveBeenCalled();
  });

  it('rejects multiple vote options for single-choice polls', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);
    const { service, deps } = createService();
    deps.dropPollsDb.findPollByDropIdForUpdate.mockResolvedValue({
      id: 'poll-1',
      wave_id: 'wave-1',
      drop_id: 'drop-1',
      closing_time: 2_000,
      multichoice: false
    });

    await expect(
      service.vote(
        {
          dropId: 'drop-1',
          voterId: 'voter-1',
          options: [1, 2]
        },
        {
          authenticationContext: AuthenticationContext.fromProfileId('voter-1')
        }
      )
    ).rejects.toThrow('Poll does not allow multiple options');
    expect(deps.dropPollsDb.replaceVoterVotes).not.toHaveBeenCalled();
  });

  it('rejects duplicate vote options', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);
    const { service, deps } = createService();

    await expect(
      service.vote(
        {
          dropId: 'drop-1',
          voterId: 'voter-1',
          options: [2, 2]
        },
        {
          authenticationContext: AuthenticationContext.fromProfileId('voter-1')
        }
      )
    ).rejects.toThrow('Poll options must be unique');
    expect(deps.dropPollsDb.findPollByDropIdForUpdate).not.toHaveBeenCalled();
    expect(deps.dropPollsDb.replaceVoterVotes).not.toHaveBeenCalled();
  });

  it('rejects votes after poll closing time', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(2_000);
    const { service, deps } = createService();
    deps.dropPollsDb.findPollByDropIdForUpdate.mockResolvedValue({
      id: 'poll-1',
      wave_id: 'wave-1',
      drop_id: 'drop-1',
      closing_time: 2_000,
      multichoice: true
    });

    await expect(
      service.vote(
        {
          dropId: 'drop-1',
          voterId: 'voter-1',
          options: [1]
        },
        {
          authenticationContext: AuthenticationContext.fromProfileId('voter-1')
        }
      )
    ).rejects.toThrow('Poll is closed');
    expect(deps.dropPollsDb.replaceVoterVotes).not.toHaveBeenCalled();
  });

  it('replaces previous poll votes with selected choices', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);
    const { service, deps } = createService();
    deps.dropPollsDb.findPollByDropIdForUpdate.mockResolvedValue({
      id: 'poll-1',
      wave_id: 'wave-1',
      drop_id: 'drop-1',
      closing_time: 2_000,
      multichoice: true
    });
    deps.dropPollsDb.findOptionsByPollId.mockResolvedValue([
      {
        poll_id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        option_no: 1,
        option_string: 'First'
      },
      {
        poll_id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        option_no: 2,
        option_string: 'Second'
      },
      {
        poll_id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        option_no: 3,
        option_string: 'Third'
      }
    ]);

    const result = await service.vote(
      {
        dropId: 'drop-1',
        voterId: 'voter-1',
        options: [2, 3]
      },
      { authenticationContext: AuthenticationContext.fromProfileId('voter-1') }
    );

    expect(deps.dropPollsDb.replaceVoterVotes).toHaveBeenCalledWith(
      {
        pollId: 'poll-1',
        waveId: 'wave-1',
        dropId: 'drop-1',
        voterId: 'voter-1',
        optionNos: [2, 3],
        voteTime: 1_000
      },
      expect.objectContaining({ connection: 'tx-connection' })
    );
    expect(deps.userNotifier.notifyOfDropPollVote).toHaveBeenCalledWith(
      {
        voter_id: 'voter-1',
        drop_id: 'drop-1',
        drop_author_id: 'author-1',
        poll_options: [
          { option_no: 2, option_string: 'Second' },
          { option_no: 3, option_string: 'Third' }
        ],
        wave_id: 'wave-1'
      },
      'visibility-group'
    );
    expect(
      (giveReadReplicaTimeToCatchUp as jest.Mock).mock.invocationCallOrder[0]
    ).toBeLessThan(
      deps.dropsService.findDropByIdOrThrow.mock.invocationCallOrder[0]
    );
    expect(deps.wsListenersNotifier.notifyAboutDropUpdate).toHaveBeenCalledWith(
      { id: 'drop-1' },
      { authenticationContext: AuthenticationContext.fromProfileId('voter-1') },
      { reason: 'POLL_RESPONSE' }
    );
    expect(result).toEqual({ id: 'drop-1' });
  });

  it('does not notify or broadcast when poll vote selections are unchanged', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(1_000);
    const { service, deps } = createService();
    deps.dropPollsDb.replaceVoterVotes.mockResolvedValue(false);
    deps.dropPollsDb.findPollByDropIdForUpdate.mockResolvedValue({
      id: 'poll-1',
      wave_id: 'wave-1',
      drop_id: 'drop-1',
      closing_time: 2_000,
      multichoice: true
    });
    deps.dropPollsDb.findOptionsByPollId.mockResolvedValue([
      {
        poll_id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        option_no: 2,
        option_string: 'Second'
      },
      {
        poll_id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        option_no: 3,
        option_string: 'Third'
      }
    ]);

    const result = await service.vote(
      {
        dropId: 'drop-1',
        voterId: 'voter-1',
        options: [2, 3]
      },
      { authenticationContext: AuthenticationContext.fromProfileId('voter-1') }
    );

    expect(deps.userNotifier.notifyOfDropPollVote).not.toHaveBeenCalled();
    expect(giveReadReplicaTimeToCatchUp).not.toHaveBeenCalled();
    expect(deps.dropsService.findDropByIdOrThrow).not.toHaveBeenCalled();
    expect(
      deps.wsListenersNotifier.notifyAboutDropUpdate
    ).not.toHaveBeenCalled();
    expect(deps.dropsService.findDropsV2ByIds).toHaveBeenCalledWith(
      ['drop-1'],
      { authenticationContext: AuthenticationContext.fromProfileId('voter-1') }
    );
    expect(result).toEqual({ id: 'drop-1' });
  });

  it('returns wave poll drops in poll query order', async () => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(5_000);
    const { service, deps } = createService();
    deps.dropPollsDb.countWavePolls.mockResolvedValue(3);
    deps.dropPollsDb.findWavePolls.mockResolvedValue([
      {
        id: 'poll-2',
        wave_id: 'wave-1',
        drop_id: 'drop-2',
        closing_time: 7_000,
        multichoice: false,
        created_at: 2_000,
        options: [],
        voted: []
      },
      {
        id: 'poll-1',
        wave_id: 'wave-1',
        drop_id: 'drop-1',
        closing_time: 6_000,
        multichoice: true,
        created_at: 1_000,
        options: [],
        voted: []
      }
    ]);
    deps.dropsService.findDropsV2ByIds.mockResolvedValue({
      'drop-1': { id: 'drop-1' },
      'drop-2': { id: 'drop-2' }
    });

    const result = await service.findWavePolls(
      {
        wave_id: 'wave-1',
        page: 1,
        page_size: 2,
        sort_direction: PageSortDirection.DESC,
        sort: DropPollsOrderBy.CREATED_AT,
        state: DropPollState.OPEN
      },
      {}
    );

    expect(deps.dropPollsDb.countWavePolls).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        state: DropPollState.OPEN,
        now: 5_000
      },
      {}
    );
    expect(deps.dropPollsDb.findWavePolls).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        limit: 2,
        offset: 0,
        order: PageSortDirection.DESC,
        orderBy: DropPollsOrderBy.CREATED_AT,
        state: DropPollState.OPEN,
        now: 5_000
      },
      {}
    );
    expect(deps.dropsService.findDropsV2ByIds).toHaveBeenCalledWith(
      ['drop-2', 'drop-1'],
      {}
    );
    expect(result).toEqual({
      count: 3,
      page: 1,
      next: true,
      data: [{ id: 'drop-2' }, { id: 'drop-1' }]
    });
  });
});
