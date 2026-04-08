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
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
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
      {} as any
    );
  }

  function createUseCaseWithMocks(
    overrides: {
      dropsDb?: any;
      wavesApiDb?: any;
      deleteDropUseCase?: any;
      artCurationTokenWatchService?: any;
    } = {}
  ) {
    return new CreateOrUpdateDropUseCase(
      overrides.dropsDb ?? ({} as any),
      {} as any,
      {} as any,
      overrides.wavesApiDb ?? ({} as any),
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      overrides.deleteDropUseCase ?? ({} as any),
      {} as any,
      {} as any,
      overrides.artCurationTokenWatchService ?? ({} as any)
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
      mentioned_groups: [],
      signature: null
    };
  }

  function createGroupMentionModel() {
    return {
      ...createIdentitySubmissionModel('alice.eth'),
      mentioned_groups: [DropGroupMention.ALL]
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

  it('allows wave creators to use group mentions', () => {
    const useCase = createUseCase({
      existingNominations: []
    });

    expect(() =>
      (useCase as any).verifyGroupMentions({
        model: createGroupMentionModel(),
        wave: {
          created_by: 'author-profile',
          admin_group_id: 'admins'
        },
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
  });

  it('allows wave admins to use group mentions', () => {
    const useCase = createUseCase({
      existingNominations: []
    });

    expect(() =>
      (useCase as any).verifyGroupMentions({
        model: createGroupMentionModel(),
        wave: {
          created_by: 'another-profile',
          admin_group_id: 'admins'
        },
        groupIdsUserIsEligibleFor: ['admins']
      })
    ).not.toThrow();
  });

  it('rejects group mentions from non-admins', () => {
    const useCase = createUseCase({
      existingNominations: []
    });

    expect(() =>
      (useCase as any).verifyGroupMentions({
        model: createGroupMentionModel(),
        wave: {
          created_by: 'another-profile',
          admin_group_id: 'admins'
        },
        groupIdsUserIsEligibleFor: ['members']
      })
    ).toThrow(`Only wave creators or admins can mention groups`);
  });

  it('rejects group mentions on drop updates', () => {
    const useCase = createUseCase({
      existingNominations: []
    });

    expect(() =>
      (useCase as any).verifyGroupMentions({
        model: {
          ...createGroupMentionModel(),
          drop_id: 'drop-1'
        },
        wave: {
          created_by: 'author-profile',
          admin_group_id: 'admins'
        },
        groupIdsUserIsEligibleFor: ['admins']
      })
    ).toThrow(`Group mentions can only be used when creating a drop`);
  });
});
