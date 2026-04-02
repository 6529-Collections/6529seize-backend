import { AuthenticationContext } from '@/auth-context';
import { DropType, DropEntity } from '@/entities/IDrop';
import { ApiProfileMin } from '../generated/models/ApiProfileMin';
import { DropsMappers } from './drops.mappers';

function aProfileMin(id: string): ApiProfileMin {
  return {
    id,
    handle: `id-${id}`,
    banner1_color: null,
    banner2_color: null,
    cic: 0,
    rep: 0,
    tdh: 0,
    xtdh: 0,
    xtdh_rate: 0,
    tdh_rate: 0,
    level: 0,
    pfp: null,
    archived: false,
    subscribed_actions: [],
    primary_address: '',
    active_main_stage_submission_ids: [],
    winner_main_stage_drop_ids: [],
    artist_of_prevote_cards: [],
    is_wave_creator: false
  };
}

function aResolvedIdentityProfile(id: string) {
  return {
    ...aProfileMin(id),
    bio: `bio-${id}`,
    top_rep_categories: [
      {
        category: 'LEADERSHIP',
        rep: -12
      },
      {
        category: 'STRATEGY',
        rep: 8
      }
    ]
  };
}

describe('DropsMappers', () => {
  it('uses the transactional connection when resolving identity metadata profiles', async () => {
    const userGroupsService = {
      getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
    };
    const identityFetcher = {
      getOverviewsByIds: jest.fn().mockResolvedValue({
        'author-profile': aProfileMin('author-profile'),
        'nominated-profile': aProfileMin('nominated-profile')
      }),
      getDropResolvedIdentitiesByIds: jest.fn().mockResolvedValue({
        'nominated-profile': aResolvedIdentityProfile('nominated-profile')
      })
    };
    const dropsDb = {
      getQuoteIds: jest.fn().mockResolvedValue([]),
      getDropsByIds: jest.fn(),
      getDropsParts: jest.fn().mockResolvedValue({ 'drop-1': [] }),
      findMentionsByDropIds: jest.fn().mockResolvedValue([]),
      findMentionedWavesByDropIds: jest.fn().mockResolvedValue([]),
      findReferencedNftsByDropIds: jest.fn().mockResolvedValue([]),
      findMetadataByDropIds: jest.fn().mockResolvedValue([
        {
          drop_id: 'drop-1',
          data_key: 'identity',
          data_value: 'nominated-profile'
        }
      ]),
      getDropMedia: jest.fn().mockResolvedValue([]),
      getWinDecisionsForDrops: jest.fn().mockResolvedValue({}),
      findDeletedDrops: jest.fn().mockResolvedValue({}),
      findDropIdsOfWavesWhereNegativeVotesAreNotAllowed: jest
        .fn()
        .mockResolvedValue([]),
      countBoostsOfGivenDrops: jest.fn().mockResolvedValue({})
    };
    const wavesApiDb = {
      whichOfWavesArePinnedByGivenProfile: jest
        .fn()
        .mockResolvedValue(new Set<string>())
    };
    const identitySubscriptionsDb = {
      findIdentitySubscriptionActionsOfTargets: jest.fn()
    };
    const dropVotingDb = {
      getParticipationDropsRealtimeRanks: jest.fn().mockResolvedValue({}),
      findDropsTopContributors: jest.fn().mockResolvedValue({}),
      getTallyForDrops: jest.fn().mockResolvedValue({}),
      getWinningDropsTopRaters: jest.fn().mockResolvedValue({}),
      getWinningDropsRatersCount: jest.fn().mockResolvedValue({}),
      getTimeLockedDropsWeightedVotes: jest.fn().mockResolvedValue({}),
      getWeightedDropRates: jest.fn().mockResolvedValue({})
    };
    const dropVotingService = {
      findCreditLeftForVotingForDrops: jest.fn().mockResolvedValue({})
    };
    const reactionsDb = {
      getByDropIds: jest.fn().mockResolvedValue(new Map())
    };
    const dropBookmarksDb = {
      findBookmarkedDropIds: jest.fn()
    };
    const curationsDb = {
      findWaveCurationGroupsByWaveIds: jest.fn().mockResolvedValue([]),
      findCuratedDropIdsByCurator: jest.fn().mockResolvedValue(new Set())
    };
    const dropNftLinksDb = {
      findByDropIds: jest.fn().mockResolvedValue([])
    };
    const nftLinksDb = {
      findByCanonicalIds: jest.fn().mockResolvedValue([])
    };
    const nftLinkResolvingService = {
      refreshStaleTrackingForUrls: jest.fn()
    };

    const mapper = new DropsMappers(
      userGroupsService as any,
      identityFetcher as any,
      dropsDb as any,
      wavesApiDb as any,
      identitySubscriptionsDb as any,
      dropVotingDb as any,
      dropVotingService as any,
      reactionsDb as any,
      dropBookmarksDb as any,
      curationsDb as any,
      dropNftLinksDb as any,
      nftLinksDb as any,
      nftLinkResolvingService as any
    );

    const dropEntity: DropEntity = {
      id: 'drop-1',
      serial_no: 1,
      drop_type: DropType.CHAT,
      wave_id: 'wave-1',
      author_id: 'author-profile',
      title: null,
      reply_to_drop_id: null,
      reply_to_part_id: null,
      parts_count: 0,
      created_at: 1,
      updated_at: null,
      signature: null,
      hide_link_preview: false
    } as DropEntity;
    dropsDb.getDropsByIds.mockResolvedValue([dropEntity]);
    const connection = { connection: { id: 'tx' } } as any;

    const [mappedDrop] = await mapper.convertToDropsWithoutWaves([dropEntity], {
      connection,
      authenticationContext: AuthenticationContext.notAuthenticated()
    });

    expect(identityFetcher.getOverviewsByIds).toHaveBeenCalledTimes(1);
    expect(identityFetcher.getOverviewsByIds.mock.calls[0][1]).toMatchObject({
      connection
    });
    expect(
      identityFetcher.getDropResolvedIdentitiesByIds
    ).toHaveBeenCalledTimes(1);
    expect(
      identityFetcher.getDropResolvedIdentitiesByIds.mock.calls[0][0]
    ).toMatchObject({
      ids: ['nominated-profile'],
      baseProfilesById: {
        'nominated-profile': aProfileMin('nominated-profile')
      }
    });
    expect(
      identityFetcher.getDropResolvedIdentitiesByIds.mock.calls[0][1]
    ).toMatchObject({
      connection
    });
    expect(mappedDrop.metadata[0].resolved_profile).toEqual(
      aResolvedIdentityProfile('nominated-profile')
    );
  });
});
