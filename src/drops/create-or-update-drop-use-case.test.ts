const mockResolveName = jest.fn();

jest.mock('@/alchemy', () => ({
  getAlchemyInstance: jest.fn(() => ({
    core: {
      resolveName: mockResolveName
    }
  }))
}));

import { identitiesDb } from '@/identities/identities.db';
import { DropType } from '@/entities/IDrop';
import { WaveIdentitySubmissionDuplicates } from '@/entities/IWave';
import { profilesService } from '@/profiles/profiles.service';
import { CreateOrUpdateDropUseCase } from './create-or-update-drop.use-case';

describe('CreateOrUpdateDropUseCase', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockResolveName.mockReset();
  });

  function createUseCase({
    existingNominations
  }: {
    existingNominations: Array<{ has_won: boolean }>;
  }) {
    const identityWavesService = {
      setIdentityWaveIfEligible: jest.fn().mockResolvedValue(false)
    };
    return new CreateOrUpdateDropUseCase(
      {
        findIdentityNominationDropsForWave: jest
          .fn()
          .mockResolvedValue(existingNominations)
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      identityWavesService as any
    );
  }

  function createIdentitySubmissionModel(identity: string) {
    return {
      drop_id: null,
      wave_id: 'wave-1',
      reply_to: null,
      title: null,
      parts: [
        {
          content: 'content',
          quoted_drop: null,
          media: []
        }
      ],
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [
        {
          data_key: 'identity',
          data_value: identity
        }
      ],
      author_identity: 'author-profile',
      author_id: 'author-profile',
      drop_type: DropType.PARTICIPATORY,
      mentions_all: false,
      signature: null
    };
  }

  async function verifyIdentitySubmissionDuplicates(
    useCase: CreateOrUpdateDropUseCase
  ) {
    await (useCase as any).verifyIdentitySubmissionDuplicates(
      {
        nominatedProfileId: 'nominated-profile',
        waveId: 'wave-1',
        duplicatesPolicy: WaveIdentitySubmissionDuplicates.ALLOW_AFTER_WIN,
        currentDropId: null
      },
      {
        connection: {}
      }
    );
  }

  it('allows a post-win duplicate when the wave already has a winner', async () => {
    const useCase = createUseCase({
      existingNominations: [{ has_won: true }]
    });

    await expect(
      verifyIdentitySubmissionDuplicates(useCase)
    ).resolves.toBeUndefined();
  });

  it('rejects an active duplicate before any nomination has won', async () => {
    const useCase = createUseCase({
      existingNominations: [{ has_won: false }]
    });

    await expect(verifyIdentitySubmissionDuplicates(useCase)).rejects.toThrow(
      `This identity already has an active nomination in the wave`
    );
  });

  it('rejects a duplicate when a winner exists but another active nomination remains', async () => {
    const useCase = createUseCase({
      existingNominations: [{ has_won: true }, { has_won: false }]
    });

    await expect(verifyIdentitySubmissionDuplicates(useCase)).rejects.toThrow(
      `This identity already has an active nomination in the wave`
    );
  });

  it('pre-resolves ENS nominations before transactional execution', async () => {
    const useCase = createUseCase({
      existingNominations: []
    });
    mockResolveName.mockResolvedValue(
      '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD'
    );

    await expect(
      useCase.preResolveIdentityNomination(
        createIdentitySubmissionModel('Alice.ETH'),
        {}
      )
    ).resolves.toEqual({
      normalizedEnsName: 'alice.eth',
      normalizedWallet: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    });
  });

  it('uses pre-resolved ENS data inside the transaction path without calling Alchemy', async () => {
    const useCase = createUseCase({
      existingNominations: []
    });
    const normalizedWallet = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    const updateWalletsEnsName = jest
      .spyOn(identitiesDb, 'updateWalletsEnsName')
      .mockResolvedValue(undefined);
    const makeSureProfilesAreCreatedAndGetProfileIdsByAddresses = jest
      .spyOn(
        profilesService,
        'makeSureProfilesAreCreatedAndGetProfileIdsByAddresses'
      )
      .mockResolvedValue({
        [normalizedWallet]: 'nominated-profile'
      });

    await expect(
      (useCase as any).resolveIdentityNominationProfileId('alice.eth', {
        connection: {},
        preResolvedIdentityNomination: {
          normalizedEnsName: 'alice.eth',
          normalizedWallet
        }
      })
    ).resolves.toBe('nominated-profile');

    expect(updateWalletsEnsName).toHaveBeenCalledWith(
      {
        wallet: normalizedWallet,
        ensName: 'alice.eth'
      },
      {}
    );
    expect(
      makeSureProfilesAreCreatedAndGetProfileIdsByAddresses
    ).toHaveBeenCalledWith([normalizedWallet], {
      timer: undefined,
      connection: {}
    });
    expect(mockResolveName).not.toHaveBeenCalled();
  });

  it('marks a newly created qualifying wave as the author identity wave', async () => {
    const identityWavesService = {
      setIdentityWaveIfEligible: jest.fn().mockResolvedValue(true)
    };
    const metricsRecorder = {
      recordDrop: jest.fn().mockResolvedValue(undefined),
      recordActiveIdentity: jest.fn().mockResolvedValue(undefined)
    };
    const useCase = new CreateOrUpdateDropUseCase(
      {
        findIdentityNominationDropsForWave: jest.fn(),
        findDropById: jest.fn(),
        executeNativeQueriesInTransaction: jest.fn(),
        insertDrop: jest.fn(),
        insertDropParts: jest.fn(),
        insertDropMentions: jest.fn(),
        insertDropMentionedWaves: jest.fn(),
        insertDropReferencedNfts: jest.fn(),
        insertDropMedia: jest.fn(),
        insertDropMetadata: jest.fn(),
        findNftDetailsByReferencedNfts: jest.fn().mockResolvedValue({})
      } as any,
      {} as any,
      {
        getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
      } as any,
      {
        findById: jest.fn().mockResolvedValue({
          id: 'wave-1',
          type: 'CHAT',
          chat_group_id: null,
          chat_enabled: true,
          participation_group_id: null,
          participation_required_media: [],
          participation_required_metadata: [],
          submission_type: null,
          participation_signature_required: false,
          participation_period_start: null,
          participation_period_end: null,
          participation_max_applications_per_participant: null,
          visibility_group_id: null
        })
      } as any,
      {
        notifyAllNotificationsSubscribers: jest
          .fn()
          .mockResolvedValue(undefined)
      } as any,
      {
        recordDropCreated: jest.fn().mockResolvedValue(undefined)
      } as any,
      {
        findWaveSubscribedAllSubscribers: jest.fn().mockResolvedValue([])
      } as any,
      {} as any,
      {
        execute: jest.fn().mockResolvedValue(undefined)
      } as any,
      metricsRecorder as any,
      {
        bulkDeleteForDrop: jest.fn().mockResolvedValue(undefined),
        bulkInsert: jest.fn().mockResolvedValue(undefined)
      } as any,
      {
        registerDrop: jest.fn().mockResolvedValue(undefined)
      } as any,
      identityWavesService as any
    );

    jest
      .spyOn(useCase as any, 'validateReferences')
      .mockImplementation(async (model) => model);
    jest
      .spyOn(useCase as any, 'insertAllDropComponents')
      .mockResolvedValue(undefined);
    jest.spyOn(useCase as any, 'buildDropNftLinks').mockReturnValue([]);

    await expect(
      (useCase as any).createOrUpdateDrop(
        {
          drop_id: null,
          wave_id: 'wave-1',
          reply_to: null,
          title: null,
          parts: [
            {
              content: 'hello',
              quoted_drop: null,
              media: []
            }
          ],
          referenced_nfts: [],
          mentioned_users: [],
          mentioned_waves: [],
          metadata: [],
          author_identity: 'author-profile',
          author_id: 'author-profile',
          drop_type: DropType.CHAT,
          mentions_all: false,
          signature: null
        },
        false,
        {
          connection: {},
          timer: undefined
        }
      )
    ).resolves.toEqual({ drop_id: expect.any(String) });

    expect(identityWavesService.setIdentityWaveIfEligible).toHaveBeenCalledWith(
      {
        profileId: 'author-profile',
        waveId: 'wave-1'
      },
      {
        timer: undefined,
        connection: {}
      }
    );
  });
});
