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
import { WaveIdentitySubmissionDuplicates, WaveType } from '@/entities/IWave';
import { env } from '@/env';
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
      userNotifier?: any;
      identitySubscriptionsDb?: any;
      deleteDropUseCase?: any;
      artCurationTokenWatchService?: any;
    } = {}
  ) {
    return new CreateOrUpdateDropUseCase(
      overrides.dropsDb ?? ({} as any),
      {} as any,
      {} as any,
      overrides.wavesApiDb ?? ({} as any),
      overrides.userNotifier ?? ({} as any),
      {} as any,
      overrides.identitySubscriptionsDb ?? ({} as any),
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

  it('skips all-drops notifications once the wave reaches the subscriber cap', async () => {
    jest.spyOn(env, 'getIntOrNull').mockReturnValue(15);
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([
          {
            identity_id: 'all-drops-1',
            subscribed_to_all_drops: true,
            has_group_mention: false
          },
          {
            identity_id: 'group-mention-1',
            subscribed_to_all_drops: false,
            has_group_mention: true
          },
          {
            identity_id: 'both-1',
            subscribed_to_all_drops: true,
            has_group_mention: true
          }
        ]),
      countWaveSubscribers: jest.fn().mockResolvedValue(15),
      findMutedWaveReaders: jest.fn().mockResolvedValue(['direct-muted'])
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([101])
    };
    const useCase = createUseCaseWithMocks({
      identitySubscriptionsDb,
      userNotifier
    });

    await expect(
      (useCase as any).notifyWaveDropRecipients(
        {
          model: {
            drop_id: 'drop-1',
            author_id: 'author-1',
            mentioned_groups: [DropGroupMention.ALL]
          },
          wave: {
            id: 'wave-1',
            visibility_group_id: null
          },
          directlyMentionedIdentityIds: ['direct-1', 'direct-muted']
        },
        { connection: {} }
      )
    ).resolves.toEqual([101]);

    expect(identitySubscriptionsDb.countWaveSubscribers).toHaveBeenCalledWith(
      'wave-1',
      {}
    );
    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        mentionedIdentityIds: ['direct-1', 'group-mention-1', 'both-1'],
        allDropsSubscriberIds: []
      },
      null,
      { timer: undefined, connection: {} }
    );
  });

  it('keeps all-drops notifications below the subscriber cap while deduplicating @all mentions', async () => {
    jest.spyOn(env, 'getIntOrNull').mockReturnValue(15);
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([
          {
            identity_id: 'all-drops-1',
            subscribed_to_all_drops: true,
            has_group_mention: false
          },
          {
            identity_id: 'group-mention-1',
            subscribed_to_all_drops: false,
            has_group_mention: true
          },
          {
            identity_id: 'both-1',
            subscribed_to_all_drops: true,
            has_group_mention: true
          }
        ]),
      countWaveSubscribers: jest.fn().mockResolvedValue(14),
      findMutedWaveReaders: jest.fn().mockResolvedValue([])
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([102])
    };
    const useCase = createUseCaseWithMocks({
      identitySubscriptionsDb,
      userNotifier
    });

    await expect(
      (useCase as any).notifyWaveDropRecipients(
        {
          model: {
            drop_id: 'drop-1',
            author_id: 'author-1',
            mentioned_groups: [DropGroupMention.ALL]
          },
          wave: {
            id: 'wave-1',
            visibility_group_id: null
          },
          directlyMentionedIdentityIds: ['direct-1']
        },
        { connection: {} }
      )
    ).resolves.toEqual([102]);

    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        mentionedIdentityIds: ['direct-1', 'group-mention-1', 'both-1'],
        allDropsSubscriberIds: ['all-drops-1']
      },
      null,
      { timer: undefined, connection: {} }
    );
  });

  it('rejects participatory drops in closed approve waves', async () => {
    const wavesApiDb = {
      countWaveDecisionsByWaveIds: jest.fn().mockResolvedValue({
        'wave-1': 2
      })
    };
    const useCase = createUseCaseWithMocks({ wavesApiDb });

    await expect(
      (useCase as any).verifyParticipatoryLimitations(
        {
          isDescriptionDrop: false,
          wave: {
            id: 'wave-1',
            type: WaveType.APPROVE,
            max_winners: 2,
            participation_period_start: null,
            participation_period_end: null,
            chat_enabled: true,
            participation_max_applications_per_participant: null
          },
          model: {
            drop_id: null,
            wave_id: 'wave-1',
            drop_type: DropType.PARTICIPATORY,
            signature: null,
            author_identity: 'author-1'
          }
        },
        { connection: {} }
      )
    ).rejects.toThrow(`Participation to this wave is closed`);
  });

  it('does not count wave decisions for waves that cannot be approve-closed', async () => {
    const wavesApiDb = {
      countWaveDecisionsByWaveIds: jest.fn().mockResolvedValue({
        'wave-1': 2
      })
    };
    const useCase = createUseCaseWithMocks({ wavesApiDb });

    await expect(
      (useCase as any).verifyParticipatoryLimitations(
        {
          isDescriptionDrop: false,
          wave: {
            id: 'wave-1',
            type: WaveType.RANK,
            max_winners: null,
            participation_period_start: null,
            participation_period_end: null,
            chat_enabled: true,
            participation_max_applications_per_participant: null
          },
          model: {
            drop_id: null,
            wave_id: 'wave-1',
            drop_type: DropType.PARTICIPATORY,
            signature: null,
            author_identity: 'author-1'
          }
        },
        { connection: {} }
      )
    ).resolves.toBeUndefined();

    expect(wavesApiDb.countWaveDecisionsByWaveIds).not.toHaveBeenCalled();
  });
});
