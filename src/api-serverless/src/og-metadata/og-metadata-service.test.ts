import {
  apiDropV2Service,
  ApiDropWithWave
} from '@/api/drops/api-drop-v2.service';
import { ApiDropResolvedIdentityProfileV2 } from '@/api/generated/models/ApiDropResolvedIdentityProfileV2';
import { ApiDropMainType } from '@/api/generated/models/ApiDropMainType';
import { ApiSubmissionDropStatus } from '@/api/generated/models/ApiSubmissionDropStatus';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiOgMetadataEntityType } from '@/api/generated/models/ApiOgMetadataEntityType';
import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import { IdentityFetcher } from '@/api/identities/identity.fetcher';
import { IdentitySubscriptionsDb } from '@/api/identity-subscriptions/identity-subscriptions.db';
import { OgMetadataService } from '@/api/og-metadata/og-metadata.service';
import { ApiWaveOverviewMapper } from '@/api/waves/api-wave-overview.mapper';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { BadRequestException, NotFoundException } from '@/exceptions';
import { Profile } from '@/entities/IProfile';
import { ProfilesDb } from '@/profiles/profiles.db';

const IPFS_CID = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';
const UUID_DROP_ID = '123e4567-e89b-12d3-a456-426614174000';

type IdentityFetcherMock = Pick<
  jest.Mocked<IdentityFetcher>,
  | 'getIdentityAndConsolidationsByIdentityKey'
  | 'getDropResolvedIdentityProfilesV2ByIds'
  | 'getOverviewsByIds'
>;
type WavesApiDbMock = Pick<
  jest.Mocked<WavesApiDb>,
  'findWavesByIdsEligibleForRead'
>;
type ApiWaveOverviewMapperMock = Pick<
  jest.Mocked<ApiWaveOverviewMapper>,
  'mapWaves'
>;
type DropV2ServiceMock = Pick<
  jest.Mocked<typeof apiDropV2Service>,
  'findWithWaveByIdOrThrow' | 'findDrops'
>;
type ProfilesDbMock = Pick<jest.Mocked<ProfilesDb>, 'getProfileById'>;
type IdentitySubscriptionsDbMock = Pick<
  jest.Mocked<IdentitySubscriptionsDb>,
  'countDistinctSubscriberIdsForTarget'
>;

function makeService() {
  const identityFetcher: IdentityFetcherMock = {
    getIdentityAndConsolidationsByIdentityKey: jest.fn(),
    getDropResolvedIdentityProfilesV2ByIds: jest.fn(),
    getOverviewsByIds: jest.fn()
  };
  const wavesApiDb: WavesApiDbMock = {
    findWavesByIdsEligibleForRead: jest.fn()
  };
  const apiWaveOverviewMapper: ApiWaveOverviewMapperMock = {
    mapWaves: jest.fn()
  };
  const dropV2Service: DropV2ServiceMock = {
    findWithWaveByIdOrThrow: jest.fn(),
    findDrops: jest.fn()
  };
  const profilesDb: ProfilesDbMock = {
    getProfileById: jest.fn()
  };
  const identitySubscriptionsDb: IdentitySubscriptionsDbMock = {
    countDistinctSubscriberIdsForTarget: jest.fn()
  };

  return {
    service: new OgMetadataService(
      identityFetcher,
      wavesApiDb,
      apiWaveOverviewMapper,
      dropV2Service,
      profilesDb,
      identitySubscriptionsDb
    ),
    identityFetcher,
    wavesApiDb,
    apiWaveOverviewMapper,
    dropV2Service,
    profilesDb,
    identitySubscriptionsDb
  };
}

function makeDropWithWave(id: string, serialNo: number): ApiDropWithWave {
  return {
    drop: {
      id,
      serial_no: serialNo,
      created_at: 1,
      is_signed: false,
      hide_link_preview: false,
      content: 'Drop content',
      media: [{ url: `ipfs://${IPFS_CID}/drop.png`, mime_type: 'image/png' }],
      parts_count: 1,
      priority_metadata: [
        { data_key: 'title', data_value: 'Drop title' },
        { data_key: 'description', data_value: 'Drop description' }
      ],
      author: {
        id: 'author-1',
        handle: 'artist',
        primary_address: '0xartist',
        pfp: `ipfs://${IPFS_CID}/artist.jpg`,
        level: 9,
        classification: ApiProfileClassification.Pseudonym,
        badges: {
          artist_of_main_stage_submissions: 0,
          artist_of_memes: 0
        }
      },
      drop_type: ApiDropMainType.Submission,
      boosts: 0,
      submission_context: {
        status: ApiSubmissionDropStatus.Active,
        has_metadata: true,
        voting: {
          is_open: true,
          total_votes_given: 11,
          current_calculated_vote: 9,
          predicted_final_vote: 10,
          voters_count: 3,
          place: 2
        }
      }
    },
    wave: {
      id: 'wave-1',
      name: 'Wave',
      last_drop_time: 1,
      created_at: 1,
      subscribers_count: 12,
      has_competition: false,
      is_dm_wave: false,
      links_disabled: false,
      pfp: `ipfs://${IPFS_CID}/wave.jpg`,
      description_drop: {
        contents: 'Wave description',
        media: []
      },
      total_drops_count: 34,
      is_private: false
    }
  };
}

function makeApiIdentity(overrides: Partial<ApiIdentity>): ApiIdentity {
  return {
    id: 'profile-1',
    handle: null,
    normalised_handle: null,
    pfp: null,
    cic: 0,
    rep: 0,
    level: 0,
    tdh: 0,
    tdh_rate: 0,
    xtdh: 0,
    xtdh_rate: 0,
    consolidation_key: 'consolidation-key',
    display: 'display',
    primary_wallet: '0xabc',
    banner1: null,
    banner2: null,
    classification: ApiProfileClassification.Pseudonym,
    sub_classification: null,
    active_main_stage_submission_ids: [],
    winner_main_stage_drop_ids: [],
    artist_of_prevote_cards: [],
    profile_wave_id: null,
    is_wave_creator: false,
    ...overrides
  };
}

function makeApiProfileMin(overrides: Partial<ApiProfileMin>): ApiProfileMin {
  return {
    id: 'author-1',
    handle: null,
    pfp: null,
    banner1_color: null,
    banner2_color: null,
    cic: 0,
    rep: 0,
    tdh: 0,
    tdh_rate: 0,
    xtdh: 0,
    xtdh_rate: 0,
    level: 0,
    classification: ApiProfileClassification.Pseudonym,
    sub_classification: null,
    primary_address: 'UNKNOWN',
    subscribed_actions: [],
    archived: false,
    active_main_stage_submission_ids: [],
    winner_main_stage_drop_ids: [],
    artist_of_prevote_cards: [],
    profile_wave_id: null,
    is_wave_creator: false,
    ...overrides
  };
}

function makeProfileRecord(createdAt: Date): Profile {
  return {
    external_id: 'profile-1',
    normalised_handle: 'alice',
    handle: 'alice',
    primary_wallet: '0xabc',
    created_at: createdAt,
    created_by_wallet: '0xabc'
  } as Profile;
}

function makeResolvedProfile(
  bio: string | null
): ApiDropResolvedIdentityProfileV2 {
  return {
    id: 'profile-1',
    primary_address: '0xabc',
    level: 0,
    classification: ApiProfileClassification.Pseudonym,
    badges: {
      artist_of_main_stage_submissions: 0,
      artist_of_memes: 0
    },
    bio
  } as ApiDropResolvedIdentityProfileV2;
}

function mockAuthorProfile(
  identityFetcher: IdentityFetcherMock,
  cic = 8,
  level = 9
): void {
  identityFetcher.getOverviewsByIds.mockResolvedValue({
    'author-1': makeApiProfileMin({
      id: 'author-1',
      handle: 'artist',
      primary_address: '0xartist',
      pfp: `ipfs://${IPFS_CID}/artist.jpg`,
      classification: ApiProfileClassification.Pseudonym,
      sub_classification: null,
      cic,
      level,
      active_main_stage_submission_ids: ['active-drop'],
      winner_main_stage_drop_ids: ['winning-drop']
    })
  });
}

describe('OgMetadataService', () => {
  it('returns rich profile metadata for resolved identity keys', async () => {
    const { service, identityFetcher, profilesDb, identitySubscriptionsDb } =
      makeService();
    profilesDb.getProfileById.mockResolvedValue(
      makeProfileRecord(new Date('2026-01-02T03:04:05.000Z'))
    );
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockResolvedValue(
      42
    );
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      makeApiIdentity({
        id: 'profile-1',
        handle: 'alice',
        primary_wallet: '0xabc',
        pfp: `ipfs://${IPFS_CID}/alice.jpg`,
        banner1: '#0f3BAc',
        banner2: '#000000',
        cic: 10,
        rep: 100,
        level: 7,
        tdh: 1234.5,
        classification: ApiProfileClassification.Bot,
        sub_classification: 'assistant',
        active_main_stage_submission_ids: ['active-drop'],
        winner_main_stage_drop_ids: ['winning-drop']
      })
    );
    identityFetcher.getDropResolvedIdentityProfilesV2ByIds.mockResolvedValue({
      'profile-1': makeResolvedProfile('Alice bio')
    });

    await expect(service.getProfileMetadata('alice', {})).resolves.toEqual({
      entity_type: ApiOgMetadataEntityType.Profile,
      entity_id: 'profile-1',
      profile: {
        id: 'profile-1',
        handle: 'alice',
        primary_address: '0xabc',
        profile_enabled_at: new Date('2026-01-02T03:04:05.000Z').getTime(),
        classification: ApiProfileClassification.Bot,
        sub_classification: 'assistant',
        followers_count: 42,
        has_active_submissions: true,
        has_winning_submissions: true,
        cic: 10,
        rep: 100,
        level: 7,
        tdh: 1234.5,
        description: 'Alice bio',
        twitter_handle: null,
        media: [
          {
            url: `https://ipfs.6529.io/ipfs/${IPFS_CID}/alice.jpg`,
            mime_type: null,
            width: null,
            height: null
          }
        ],
        banner: {
          primary: '#0f3BAc',
          secondary: '#000000',
          media: []
        }
      }
    });
    expect(
      identityFetcher.getIdentityAndConsolidationsByIdentityKey
    ).toHaveBeenCalledWith({ identityKey: 'alice' }, {});
    expect(
      identitySubscriptionsDb.countDistinctSubscriberIdsForTarget
    ).toHaveBeenCalledWith({
      target_id: 'profile-1',
      target_type: 'IDENTITY'
    });
  });

  it('returns profile banner image media when banner is stored as a URL', async () => {
    const { service, identityFetcher, profilesDb, identitySubscriptionsDb } =
      makeService();
    profilesDb.getProfileById.mockResolvedValue(
      makeProfileRecord(new Date('2026-01-02T03:04:05.000Z'))
    );
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockResolvedValue(
      42
    );
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      makeApiIdentity({
        id: 'profile-1',
        handle: 'alice',
        primary_wallet: '0xabc',
        pfp: null,
        banner1: `ipfs://${IPFS_CID}/banner.jpg`,
        banner2: null,
        cic: 10,
        rep: 100,
        level: 7,
        tdh: 1234.5
      })
    );
    identityFetcher.getDropResolvedIdentityProfilesV2ByIds.mockResolvedValue({
      'profile-1': makeResolvedProfile(null)
    });

    await expect(
      service.getProfileMetadata('alice', {})
    ).resolves.toMatchObject({
      profile: {
        banner: {
          primary: null,
          secondary: null,
          media: [
            {
              url: `https://ipfs.6529.io/ipfs/${IPFS_CID}/banner.jpg`,
              mime_type: null,
              width: null,
              height: null
            }
          ]
        }
      }
    });
  });

  it('returns 404 for waves hidden by existing public wave visibility', async () => {
    const { service, wavesApiDb } = makeService();
    wavesApiDb.findWavesByIdsEligibleForRead.mockResolvedValue([]);

    await expect(service.getWaveMetadata('private-wave', {})).rejects.toThrow(
      NotFoundException
    );
    expect(wavesApiDb.findWavesByIdsEligibleForRead).toHaveBeenCalledWith(
      ['private-wave'],
      [],
      undefined
    );
  });

  it('resolves numeric drops by serial number and returns lightweight author info', async () => {
    const {
      service,
      identityFetcher,
      dropV2Service,
      profilesDb,
      identitySubscriptionsDb
    } = makeService();
    profilesDb.getProfileById.mockResolvedValue(
      makeProfileRecord(new Date('2026-01-02T03:04:05.000Z'))
    );
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockResolvedValue(
      7
    );
    dropV2Service.findDrops.mockResolvedValue({
      data: [
        {
          ...makeDropWithWave('drop-1', 42).drop,
          wave: makeDropWithWave('drop-1', 42).wave
        }
      ],
      page: 1,
      next: false
    });
    mockAuthorProfile(identityFetcher);

    await expect(service.getDropMetadata('42', {})).resolves.toMatchObject({
      entity_type: ApiOgMetadataEntityType.Drop,
      entity_id: 'drop-1',
      author: {
        id: 'author-1',
        handle: 'artist',
        profile_enabled_at: new Date('2026-01-02T03:04:05.000Z').getTime(),
        classification: ApiProfileClassification.Pseudonym,
        sub_classification: null,
        followers_count: 7,
        has_active_submissions: true,
        has_winning_submissions: true,
        cic: 8,
        level: 9,
        twitter_handle: null,
        media: [
          {
            url: `https://ipfs.6529.io/ipfs/${IPFS_CID}/artist.jpg`,
            mime_type: null,
            width: null,
            height: null
          }
        ]
      },
      drop: {
        id: 'drop-1',
        serial_no: 42,
        drop_type: ApiDropMainType.Submission,
        title: 'Drop title',
        description: 'Drop description',
        content: 'Drop content',
        votes: {
          is_open: true,
          total_votes_given: 11,
          current_calculated_vote: 9,
          predicted_final_vote: 10,
          voters_count: 3,
          place: 2
        },
        media: [
          {
            url: `https://ipfs.6529.io/ipfs/${IPFS_CID}/drop.png`,
            mime_type: 'image/png',
            width: null,
            height: null
          }
        ]
      },
      wave: {
        id: 'wave-1',
        name: 'Wave',
        description: 'Wave description',
        subscribers_count: 12,
        drops_count: 34,
        media: [
          {
            url: `https://ipfs.6529.io/ipfs/${IPFS_CID}/wave.jpg`,
            mime_type: null,
            width: null,
            height: null
          }
        ]
      }
    });
    expect(dropV2Service.findDrops).toHaveBeenCalledWith(
      {
        parent_drop_id: null,
        serial_nos: [42],
        ids: null,
        page_size: 1,
        page: 1
      },
      {}
    );
  });

  it('resolves UUID drops by id and returns metadata', async () => {
    const {
      service,
      identityFetcher,
      dropV2Service,
      profilesDb,
      identitySubscriptionsDb
    } = makeService();
    profilesDb.getProfileById.mockResolvedValue(
      makeProfileRecord(new Date('2026-01-02T03:04:05.000Z'))
    );
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockResolvedValue(
      7
    );
    dropV2Service.findWithWaveByIdOrThrow.mockResolvedValue(
      makeDropWithWave(UUID_DROP_ID, 43)
    );
    mockAuthorProfile(identityFetcher);

    await expect(
      service.getDropMetadata(UUID_DROP_ID, {})
    ).resolves.toMatchObject({
      entity_type: ApiOgMetadataEntityType.Drop,
      entity_id: UUID_DROP_ID,
      author: {
        id: 'author-1',
        handle: 'artist',
        followers_count: 7,
        has_active_submissions: true,
        has_winning_submissions: true,
        cic: 8,
        level: 9
      },
      drop: {
        id: UUID_DROP_ID,
        serial_no: 43,
        drop_type: ApiDropMainType.Submission,
        title: 'Drop title',
        description: 'Drop description'
      },
      wave: {
        id: 'wave-1',
        name: 'Wave',
        description: 'Wave description'
      }
    });
    expect(dropV2Service.findWithWaveByIdOrThrow).toHaveBeenCalledWith(
      UUID_DROP_ID,
      {}
    );
  });

  it('falls back to safe profile enrichment defaults when enrichment reads fail', async () => {
    const { service, identityFetcher, profilesDb, identitySubscriptionsDb } =
      makeService();
    profilesDb.getProfileById.mockRejectedValue(
      new Error('profile read failed')
    );
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockRejectedValue(
      new Error('followers read failed')
    );
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      makeApiIdentity({
        id: 'profile-1',
        handle: 'alice',
        primary_wallet: '0xabc',
        pfp: null,
        banner1: null,
        banner2: null,
        cic: 10,
        rep: 100,
        level: 7,
        tdh: 1234.5
      })
    );
    identityFetcher.getDropResolvedIdentityProfilesV2ByIds.mockRejectedValue(
      new Error('description read failed')
    );

    await expect(
      service.getProfileMetadata('alice', {})
    ).resolves.toMatchObject({
      profile: {
        id: 'profile-1',
        description: null,
        profile_enabled_at: null,
        followers_count: 0
      }
    });
  });

  it('rejects invalid drop identifiers', async () => {
    const { service } = makeService();

    await expect(service.getDropMetadata('not-a-drop', {})).rejects.toThrow(
      BadRequestException
    );
  });
});
