import { ApiDropMainType } from '@/api/generated/models/ApiDropMainType';
import { ApiOgMetadataEntityType } from '@/api/generated/models/ApiOgMetadataEntityType';
import { ApiProfileClassification } from '@/api/generated/models/ApiProfileClassification';
import { OgMetadataService } from '@/api/og-metadata/og-metadata.service';
import { BadRequestException, NotFoundException } from '@/exceptions';

const IPFS_CID = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';

function makeService() {
  const identityFetcher = {
    getIdentityAndConsolidationsByIdentityKey: jest.fn(),
    getDropResolvedIdentityProfilesV2ByIds: jest.fn(),
    getOverviewsByIds: jest.fn()
  };
  const wavesApiDb = {
    findWavesByIdsEligibleForRead: jest.fn()
  };
  const apiWaveOverviewMapper = {
    mapWaves: jest.fn()
  };
  const dropV2Service = {
    findWithWaveByIdOrThrow: jest.fn(),
    findDrops: jest.fn()
  };
  const profilesDb = {
    getProfileById: jest.fn()
  };
  const identitySubscriptionsDb = {
    countDistinctSubscriberIdsForTarget: jest.fn()
  };

  return {
    service: new OgMetadataService(
      identityFetcher as any,
      wavesApiDb as any,
      apiWaveOverviewMapper as any,
      dropV2Service as any,
      profilesDb as any,
      identitySubscriptionsDb as any
    ),
    identityFetcher,
    wavesApiDb,
    apiWaveOverviewMapper,
    dropV2Service,
    profilesDb,
    identitySubscriptionsDb
  };
}

describe('OgMetadataService', () => {
  it('returns rich profile metadata for resolved identity keys', async () => {
    const { service, identityFetcher, profilesDb, identitySubscriptionsDb } =
      makeService();
    profilesDb.getProfileById.mockResolvedValue({
      created_at: new Date('2026-01-02T03:04:05.000Z')
    });
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockResolvedValue(
      42
    );
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      {
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
        sub_classification: 'assistant'
      }
    );
    identityFetcher.getDropResolvedIdentityProfilesV2ByIds.mockResolvedValue({
      'profile-1': { bio: 'Alice bio' }
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
    profilesDb.getProfileById.mockResolvedValue({
      created_at: new Date('2026-01-02T03:04:05.000Z')
    });
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockResolvedValue(
      42
    );
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      {
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
      }
    );
    identityFetcher.getDropResolvedIdentityProfilesV2ByIds.mockResolvedValue({
      'profile-1': { bio: null }
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
    profilesDb.getProfileById.mockResolvedValue({
      created_at: new Date('2026-01-02T03:04:05.000Z')
    });
    identitySubscriptionsDb.countDistinctSubscriberIdsForTarget.mockResolvedValue(
      7
    );
    dropV2Service.findDrops.mockResolvedValue({
      data: [
        {
          id: 'drop-1',
          serial_no: 42,
          title: null,
          content: 'Drop content',
          media: [
            { url: `ipfs://${IPFS_CID}/drop.png`, mime_type: 'image/png' }
          ],
          priority_metadata: [
            { data_key: 'title', data_value: 'Drop title' },
            { data_key: 'description', data_value: 'Drop description' }
          ],
          author: { id: 'author-1' },
          drop_type: ApiDropMainType.Submission,
          submission_context: {
            voting: {
              is_open: true,
              total_votes_given: 11,
              current_calculated_vote: 9,
              predicted_final_vote: 10,
              voters_count: 3,
              place: 2
            }
          },
          wave: {
            id: 'wave-1',
            name: 'Wave',
            subscribers_count: 12,
            total_drops_count: 34,
            pfp: `ipfs://${IPFS_CID}/wave.jpg`,
            description_drop: {
              contents: 'Wave description',
              media: []
            }
          }
        }
      ]
    });
    identityFetcher.getOverviewsByIds.mockResolvedValue({
      'author-1': {
        id: 'author-1',
        handle: 'artist',
        primary_address: '0xartist',
        pfp: `ipfs://${IPFS_CID}/artist.jpg`,
        classification: ApiProfileClassification.Pseudonym,
        sub_classification: null,
        cic: 8
      }
    });

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
        cic: 8,
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

  it('rejects invalid drop identifiers', async () => {
    const { service } = makeService();

    await expect(service.getDropMetadata('not-a-drop', {})).rejects.toThrow(
      BadRequestException
    );
  });
});
