import { ApiDropMainType } from '@/api/generated/models/ApiDropMainType';
import { ApiOgMetadataEntityType } from '@/api/generated/models/ApiOgMetadataEntityType';
import { OgMetadataService } from '@/api/og-metadata/og-metadata.service';
import { BadRequestException, NotFoundException } from '@/exceptions';

function makeService() {
  const identityFetcher = {
    getIdentityAndConsolidationsByIdentityKey: jest.fn(),
    getDropResolvedIdentityProfilesV2ByIds: jest.fn(),
    getApiIdentityOverviewsByIds: jest.fn()
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

  return {
    service: new OgMetadataService(
      identityFetcher as any,
      wavesApiDb as any,
      apiWaveOverviewMapper as any,
      dropV2Service as any
    ),
    identityFetcher,
    wavesApiDb,
    apiWaveOverviewMapper,
    dropV2Service
  };
}

describe('OgMetadataService', () => {
  it('returns rich profile metadata for resolved identity keys', async () => {
    const { service, identityFetcher } = makeService();
    identityFetcher.getIdentityAndConsolidationsByIdentityKey.mockResolvedValue(
      {
        id: 'profile-1',
        handle: 'alice',
        primary_wallet: '0xabc',
        pfp: 'https://cdn.example/alice.jpg',
        rep: 100,
        level: 7,
        tdh: 1234.5
      }
    );
    identityFetcher.getDropResolvedIdentityProfilesV2ByIds.mockResolvedValue({
      'profile-1': { bio: 'Alice bio' }
    });

    await expect(service.getProfileMetadata('alice', {})).resolves.toEqual({
      entity_type: ApiOgMetadataEntityType.Profile,
      entity_id: 'profile-1',
      title: '@alice',
      description: 'Alice bio',
      image: {
        url: 'https://cdn.example/alice.jpg',
        mime_type: null,
        width: null,
        height: null,
        alt: '@alice profile picture'
      },
      video: null,
      audio: null,
      profile: {
        id: 'profile-1',
        handle: 'alice',
        primary_address: '0xabc',
        pfp: 'https://cdn.example/alice.jpg',
        rep: 100,
        level: 7,
        tdh: 1234.5,
        description: 'Alice bio',
        twitter_handle: null
      }
    });
    expect(
      identityFetcher.getIdentityAndConsolidationsByIdentityKey
    ).toHaveBeenCalledWith({ identityKey: 'alice' }, {});
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
    const { service, identityFetcher, dropV2Service } = makeService();
    dropV2Service.findDrops.mockResolvedValue({
      data: [
        {
          id: 'drop-1',
          serial_no: 42,
          title: null,
          content: 'Drop content',
          media: [
            { url: 'https://cdn.example/drop.png', mime_type: 'image/png' }
          ],
          priority_metadata: [{ data_key: 'title', data_value: 'Drop title' }],
          author: { id: 'author-1' },
          drop_type: ApiDropMainType.Submission,
          wave: {
            id: 'wave-1',
            name: 'Wave',
            pfp: 'https://cdn.example/wave.jpg'
          }
        }
      ]
    });
    identityFetcher.getApiIdentityOverviewsByIds.mockResolvedValue({
      'author-1': {
        id: 'author-1',
        handle: 'artist',
        primary_address: '0xartist',
        pfp: 'https://cdn.example/artist.jpg'
      }
    });

    await expect(service.getDropMetadata('42', {})).resolves.toMatchObject({
      entity_type: ApiOgMetadataEntityType.Drop,
      entity_id: 'drop-1',
      title: 'Drop title',
      description: 'Drop content',
      image: {
        url: 'https://cdn.example/drop.png',
        mime_type: 'image/png'
      },
      drop: {
        id: 'drop-1',
        serial_no: 42,
        drop_type: ApiDropMainType.Submission,
        author: {
          id: 'author-1',
          handle: 'artist',
          pfp: 'https://cdn.example/artist.jpg',
          twitter_handle: null
        }
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
