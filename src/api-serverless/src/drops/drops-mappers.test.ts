import { AuthenticationContext } from '@/auth-context';
import { directMessageWaveDisplayService } from '@/api/waves/direct-message-wave-display.service';
import { DropType } from '@/entities/IDrop';
import { WaveCreditType } from '@/entities/IWave';
import { DropsMappers } from './drops.mappers';

describe('DropsMappers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createProfile(id: string, handle: string) {
    return {
      id,
      handle,
      banner1_color: null,
      banner2_color: null,
      pfp: null,
      cic: 0,
      rep: 0,
      tdh: 0,
      xtdh: 0,
      xtdh_rate: 0,
      tdh_rate: 0,
      level: 0,
      archived: false,
      subscribed_actions: [],
      primary_address: '',
      active_main_stage_submission_ids: [],
      winner_main_stage_drop_ids: [],
      artist_of_prevote_cards: [],
      is_wave_creator: false
    };
  }

  function createMapper() {
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    };
    const identityFetcher = {
      getOverviewsByIds: jest.fn().mockResolvedValue({}),
      getDropResolvedIdentitiesByIds: jest.fn().mockResolvedValue({})
    };
    const wavesApiDb = {
      findWavesByIdsEligibleFor: jest.fn().mockResolvedValue([]),
      whichOfWavesArePinnedByGivenProfile: jest
        .fn()
        .mockResolvedValue(new Set<string>()),
      getWavesByDropIds: jest.fn().mockResolvedValue({})
    };
    const curationsDb = {
      findWaveCurationGroupsByWaveIds: jest.fn().mockResolvedValue([]),
      findCuratedDropIdsByCurator: jest
        .fn()
        .mockResolvedValue(new Set<string>())
    };
    const waveSelectionsDb = {
      findWaveSelectionsByWaveIds: jest.fn().mockResolvedValue([]),
      findWaveSelectionsByDropIds: jest.fn().mockResolvedValue([])
    };

    return {
      mapper: new DropsMappers(
        userGroupsService as any,
        identityFetcher as any,
        {} as any,
        wavesApiDb as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        curationsDb as any,
        waveSelectionsDb as any,
        {} as any,
        {} as any,
        {} as any
      ),
      userGroupsService,
      identityFetcher,
      wavesApiDb,
      curationsDb,
      waveSelectionsDb
    };
  }

  function createChatDrop({
    id,
    author_id,
    reply_to_drop_id = null,
    reply_to_part_id = null,
    created_at = 1
  }: {
    id: string;
    author_id: string;
    reply_to_drop_id?: string | null;
    reply_to_part_id?: number | null;
    created_at?: number;
  }) {
    return {
      id,
      serial_no: created_at,
      drop_type: DropType.CHAT,
      wave_id: 'wave-1',
      author_id,
      created_at,
      updated_at: created_at,
      title: `${id}-title`,
      parts_count: 1,
      reply_to_drop_id,
      reply_to_part_id,
      signature: null,
      hide_link_preview: false
    } as any;
  }

  function mockRelatedData(allEntities: any[]) {
    return {
      submissionDropsVotingRanges: {},
      mentions: [],
      mentionedWaves: [],
      referencedNfts: [],
      metadata: [],
      dropsTopVoters: {},
      dropMedia: Object.fromEntries(allEntities.map((it) => [it.id, []])),
      dropsParts: Object.fromEntries(
        allEntities.map((it) => [
          it.id,
          [
            {
              drop_id: it.id,
              drop_part_id: 1,
              content: `${it.id}-content`,
              quoted_drop_id: null,
              quoted_drop_part_id: null
            }
          ]
        ])
      ),
      subscribedActions: {},
      deletedDrops: {},
      dropsVoteCounts: {},
      allEntities,
      dropsRanks: {},
      winDecisions: {},
      winningDropsTopRaters: {},
      winningDropsRatersCounts: {},
      winningDropsRatingsByVoter: {},
      weightedDropsRanks: {},
      weightedDropsRates: {},
      dropsInWavesWhereNegativeVotesAreNotAllowed: [],
      dropReactions: new Map(),
      boostsCount: {},
      boostsByAuthenticatedUser: new Set<string>(),
      bookmarksByAuthenticatedUser: new Set<string>(),
      rootDropNftLinksByDropId: {}
    };
  }

  it('includes selections for root and nested reply drops', async () => {
    const { mapper, identityFetcher, waveSelectionsDb } = createMapper();
    const rootDrop = createChatDrop({
      id: 'drop-1',
      author_id: 'author-1',
      reply_to_drop_id: 'drop-2',
      reply_to_part_id: 1,
      created_at: 1
    });
    const replyDrop = createChatDrop({
      id: 'drop-2',
      author_id: 'author-2',
      created_at: 2
    });

    identityFetcher.getOverviewsByIds.mockResolvedValue({
      'author-1': createProfile('author-1', 'root-author'),
      'author-2': createProfile('author-2', 'reply-author')
    });
    waveSelectionsDb.findWaveSelectionsByDropIds.mockResolvedValue([
      { drop_id: 'drop-1', id: 'selection-1', title: 'Featured' },
      { drop_id: 'drop-2', id: 'selection-2', title: 'Replies' }
    ]);
    jest
      .spyOn(mapper as any, 'getAllDropsRelatedData')
      .mockResolvedValue(mockRelatedData([rootDrop, replyDrop]));

    const [result] = await mapper.convertToDropsWithoutWaves([rootDrop], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    } as any);

    expect(waveSelectionsDb.findWaveSelectionsByDropIds).toHaveBeenCalledWith(
      ['drop-1', 'drop-2'],
      undefined
    );
    expect(result.selections).toEqual([
      { id: 'selection-1', title: 'Featured' }
    ]);
    expect(result.reply_to?.drop?.selections).toEqual([
      { id: 'selection-2', title: 'Replies' }
    ]);
  });

  it('defaults selections to an empty array when a drop has no memberships', async () => {
    const { mapper, identityFetcher, waveSelectionsDb } = createMapper();
    const rootDrop = createChatDrop({
      id: 'drop-1',
      author_id: 'author-1'
    });

    identityFetcher.getOverviewsByIds.mockResolvedValue({
      'author-1': createProfile('author-1', 'root-author')
    });
    waveSelectionsDb.findWaveSelectionsByDropIds.mockResolvedValue([]);
    jest
      .spyOn(mapper as any, 'getAllDropsRelatedData')
      .mockResolvedValue(mockRelatedData([rootDrop]));

    const [result] = await mapper.convertToDropsWithoutWaves([rootDrop], {
      authenticationContext: AuthenticationContext.notAuthenticated()
    } as any);

    expect(result.selections).toEqual([]);
  });

  it('preserves selections when expanding ApiDrop responses', async () => {
    const { mapper, userGroupsService, wavesApiDb, waveSelectionsDb } =
      createMapper();
    const selections = [{ id: 'selection-1', title: 'Featured' }];

    jest.spyOn(mapper, 'convertToDropsWithoutWaves').mockResolvedValue([
      {
        id: 'drop-1',
        serial_no: 1,
        drop_type: 'CHAT',
        rank: null,
        author: createProfile('author-1', 'root-author'),
        created_at: 1,
        updated_at: 1,
        title: 'drop-1-title',
        parts: [],
        parts_count: 0,
        referenced_nfts: [],
        mentioned_users: [],
        mentioned_waves: [],
        metadata: [],
        selections,
        rating: 0,
        realtime_rating: 0,
        rating_prediction: 0,
        top_raters: [],
        raters_count: 0,
        context_profile_context: null,
        subscribed_actions: [],
        is_signed: false,
        reactions: [],
        boosts: 0,
        hide_link_preview: false
      } as any
    ]);
    wavesApiDb.getWavesByDropIds.mockResolvedValue({
      'drop-1': {
        id: 'wave-1',
        name: 'Wave 1',
        picture: null,
        description_drop_id: 'drop-1',
        last_drop_time: 1,
        submission_type: null,
        chat_enabled: false,
        chat_group_id: null,
        voting_group_id: null,
        participation_group_id: null,
        admin_group_id: null,
        voting_credit_type: WaveCreditType.TDH,
        voting_period_start: null,
        voting_period_end: null,
        visibility_group_id: null,
        admin_drop_deletion_enabled: false,
        forbid_negative_votes: false
      }
    });
    wavesApiDb.whichOfWavesArePinnedByGivenProfile.mockResolvedValue(
      new Set<string>()
    );
    waveSelectionsDb.findWaveSelectionsByWaveIds.mockResolvedValue([]);
    userGroupsService.getGroupsUserIsEligibleFor.mockResolvedValue([]);
    jest
      .spyOn(
        directMessageWaveDisplayService,
        'resolveWaveDisplayByWaveIdForContext'
      )
      .mockResolvedValue({});

    const [result] = await mapper.convertToDropFulls({
      dropEntities: [{ id: 'drop-1', wave_id: 'wave-1' } as any],
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(result.selections).toEqual(selections);
  });
});
