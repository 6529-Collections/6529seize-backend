import { AuthenticationContext } from '@/auth-context';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { anIdentity } from '@/tests/fixtures/identity.fixture';

describe('IdentityFetcher identity waves', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createFetcher(identityOverrides?: Record<string, any>) {
    const identitiesDb = {
      getIdentitiesByIds: jest
        .fn()
        .mockResolvedValue([anIdentity(identityOverrides ?? {}, undefined)]),
      getActiveMainStageDropIds: jest.fn().mockResolvedValue({}),
      getMainStageWinnerDropIds: jest.fn().mockResolvedValue({}),
      getArtistOfPrevoteCards: jest.fn().mockResolvedValue({}),
      getWaveCreatorProfileIds: jest.fn().mockResolvedValue(new Set<string>()),
      getNewestVersionHandlesOfArchivedProfiles: jest.fn().mockResolvedValue([])
    };
    const identitySubscriptionsDb = {
      findIdentitySubscriptionActionsOfTargets: jest.fn().mockResolvedValue({})
    };
    return new IdentityFetcher(
      identitiesDb as any,
      identitySubscriptionsDb as any,
      jest.fn() as any
    );
  }

  it('hydrates identity_wave for public waves', async () => {
    const identity = anIdentity({
      wave_id: 'wave-1'
    });
    const fetcher = createFetcher(identity);
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
      .mockResolvedValue([]);
    jest.spyOn(wavesApiDb, 'findWavesByIdsEligibleForRead').mockResolvedValue([
      {
        id: 'wave-1',
        name: 'wave-1',
        picture: null,
        description_drop_id: 'description-drop-1',
        last_drop_time: 42,
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
        forbid_negative_votes: false
      } as any
    ]);
    jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set(['wave-1']));

    const overviews = await fetcher.getOverviewsByIds([identity.profile_id!], {
      authenticationContext: AuthenticationContext.fromProfileId(
        identity.profile_id!
      ),
      timer: undefined
    });

    expect(overviews[identity.profile_id!]?.identity_wave).toEqual(
      expect.objectContaining({
        id: 'wave-1',
        pinned: true
      })
    );
  });

  it('returns null for private identity waves', async () => {
    const identity = anIdentity({
      wave_id: 'wave-1'
    });
    const fetcher = createFetcher(identity);
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
      .mockResolvedValue(['group-1']);
    jest.spyOn(wavesApiDb, 'findWavesByIdsEligibleForRead').mockResolvedValue([
      {
        id: 'wave-1',
        name: 'wave-1',
        picture: null,
        description_drop_id: 'description-drop-1',
        last_drop_time: 42,
        submission_type: null,
        chat_enabled: true,
        chat_group_id: null,
        voting_group_id: null,
        participation_group_id: null,
        admin_group_id: null,
        voting_credit_type: 'TDH',
        voting_period_start: null,
        voting_period_end: null,
        visibility_group_id: 'group-1',
        admin_drop_deletion_enabled: false,
        forbid_negative_votes: false
      } as any
    ]);
    jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set(['wave-1']));

    const overviews = await fetcher.getOverviewsByIds([identity.profile_id!], {
      authenticationContext: AuthenticationContext.fromProfileId(
        identity.profile_id!
      ),
      timer: undefined
    });

    expect(overviews[identity.profile_id!]?.identity_wave).toBeNull();
  });

  it('does not overstate vote or participation rights for proxies', async () => {
    const identity = anIdentity({
      wave_id: 'wave-1'
    });
    const fetcher = createFetcher(identity);
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
      .mockResolvedValue([]);
    jest.spyOn(wavesApiDb, 'findWavesByIdsEligibleForRead').mockResolvedValue([
      {
        id: 'wave-1',
        name: 'wave-1',
        picture: null,
        description_drop_id: 'description-drop-1',
        last_drop_time: 42,
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
        forbid_negative_votes: false
      } as any
    ]);
    jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set(['wave-1']));

    const overviews = await fetcher.getOverviewsByIds([identity.profile_id!], {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'proxy-1',
        roleProfileId: identity.profile_id!,
        activeProxyActions: []
      }),
      timer: undefined
    });

    expect(overviews[identity.profile_id!]?.identity_wave).toEqual(
      expect.objectContaining({
        authenticated_user_eligible_to_vote: false,
        authenticated_user_eligible_to_participate: false
      })
    );
  });

  it('treats proxies without READ_WAVE as anonymous for pin lookup', async () => {
    const identity = anIdentity({
      wave_id: 'wave-1'
    });
    const fetcher = createFetcher(identity);
    jest.spyOn(wavesApiDb, 'findWavesByIdsEligibleForRead').mockResolvedValue([
      {
        id: 'wave-1',
        name: 'wave-1',
        picture: null,
        description_drop_id: 'description-drop-1',
        last_drop_time: 42,
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
        forbid_negative_votes: false
      } as any
    ]);
    const pinnedLookup = jest
      .spyOn(wavesApiDb, 'whichOfWavesArePinnedByGivenProfile')
      .mockResolvedValue(new Set());

    const overviews = await fetcher.getOverviewsByIds([identity.profile_id!], {
      authenticationContext: new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'proxy-1',
        roleProfileId: identity.profile_id!,
        activeProxyActions: []
      }),
      timer: undefined
    });

    expect(pinnedLookup).toHaveBeenCalledWith(
      {
        waveIds: ['wave-1'],
        profileId: null
      },
      expect.anything()
    );
    expect(overviews[identity.profile_id!]?.identity_wave).toEqual(
      expect.objectContaining({
        pinned: false
      })
    );
  });
});
