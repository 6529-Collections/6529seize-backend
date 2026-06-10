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
import { AttachmentStatus } from '@/entities/IAttachment';
import { DropGroupMention } from '@/entities/IWaveGroupNotificationSubscription';
import { WaveIdentitySubmissionDuplicates, WaveType } from '@/entities/IWave';
import { env } from '@/env';
import { profilesService } from '@/profiles/profiles.service';
import { CLOUDFRONT_LINK } from '@/constants';
import {
  CreateOrUpdateDropUseCase,
  validateDropMediaAttachment
} from './create-or-update-drop.use-case';

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
      attachmentsDb?: any;
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
      overrides.artCurationTokenWatchService ?? ({} as any),
      overrides.attachmentsDb ?? ({} as any)
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
      signature: null,
      is_additional_action_promised: null
    };
  }

  function createGroupMentionModel() {
    return {
      ...createIdentitySubmissionModel('alice.eth'),
      mentioned_groups: [DropGroupMention.ALL]
    };
  }

  function createSlowModeWave(overrides: Record<string, unknown> = {}) {
    return {
      id: 'wave-1',
      created_by: 'creator-profile',
      admin_group_id: null,
      chat_enabled: true,
      chat_group_id: null,
      chat_slow_mode_cooldown_ms: 60000,
      chat_links_disabled: false,
      ...overrides
    };
  }

  function createChatDropModel(overrides: Record<string, unknown> = {}) {
    return {
      drop_id: null,
      wave_id: 'wave-1',
      drop_type: DropType.CHAT,
      author_identity: 'author-profile',
      author_id: 'author-profile',
      parts: [
        {
          content: 'hello',
          quoted_drop: null,
          media: []
        }
      ],
      ...overrides
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

  it('rejects non-admin chat drops with links when links are disabled', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content: 'see https://example.com',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).toThrow(`Chat drops with links are not allowed in this wave`);
  });

  it('rejects non-admin chat drop edits with links when links are disabled', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          drop_id: 'drop-1',
          parts: [
            {
              content: 'edited to www.example.com',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).toThrow(`Chat drops with links are not allowed in this wave`);
  });

  it('allows wave creators and admins to send chat drops with links when links are disabled', () => {
    const useCase = createUseCaseWithMocks();
    const model = createChatDropModel({
      parts: [
        {
          content: 'see http://example.com',
          quoted_drop: null,
          media: []
        }
      ]
    });

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({
          created_by: 'author-profile',
          chat_links_disabled: true
        }),
        model,
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({
          created_by: 'another-profile',
          admin_group_id: 'admins',
          chat_links_disabled: true
        }),
        model,
        groupIdsUserIsEligibleFor: ['admins']
      })
    ).not.toThrow();
  });

  it('does not treat media URLs as disabled chat links', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content: 'image attached',
              quoted_drop: null,
              media: [
                {
                  url: 'https://example.com/image.png',
                  mime_type: 'image/png'
                }
              ]
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
  });

  it('allows Tenor media links when chat links are disabled', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content: 'reaction https://media.tenor.com/abc123/tenor.gif',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
  });

  it('allows only configured Tenor file extensions in chat link allowlist', () => {
    const useCase = createUseCaseWithMocks();

    for (const extension of ['gif', 'mp4', 'jpg', 'webp']) {
      expect(
        (useCase as any).isAllowedChatLink(
          `https://media.tenor.com/abc123/tenor.${extension}?item=1`
        )
      ).toBe(true);
    }
    for (const extension of ['jpeg', 'png', 'html']) {
      expect(
        (useCase as any).isAllowedChatLink(
          `https://media.tenor.com/abc123/tenor.${extension}`
        )
      ).toBe(false);
    }
    expect(
      (useCase as any).isAllowedChatLink('https://media.tenor.com/abc123/tenor')
    ).toBe(false);
  });

  it('allows CloudFront media links when chat links are disabled', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content:
                'uploaded https://d3lqz0a4bldqgf.cloudfront.net/drops/asset.png',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
    expect(
      (useCase as any).isAllowedChatLink(
        'https://d3lqz0a4bldqgf.cloudfront.net/drops/asset.html'
      )
    ).toBe(true);
  });

  it('allows scheme-less Tenor candidates in chat link allowlist', () => {
    const useCase = createUseCaseWithMocks();

    expect(
      (useCase as any).isAllowedChatLink('media.tenor.com/abc123/tenor.gif')
    ).toBe(true);
    expect(
      (useCase as any).isAllowedChatLink('//media.tenor.com/abc123/tenor.gif')
    ).toBe(true);
    expect(
      (useCase as any).isAllowedChatLink(
        'media.tenor.com.evil/abc123/tenor.gif'
      )
    ).toBe(false);
  });

  it('rejects mixed Tenor and non-Tenor links when chat links are disabled', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content:
                'reaction https://media.tenor.com/abc123/tenor.gif https://example.com',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).toThrow(`Chat drops with links are not allowed in this wave`);
  });

  it('rejects Tenor lookalike links when chat links are disabled', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content: 'fake https://media.tenor.com.evil/abc123/tenor.gif',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).toThrow(`Chat drops with links are not allowed in this wave`);
  });

  it('rejects CloudFront lookalike links when chat links are disabled', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content:
                'fake https://d3lqz0a4bldqgf.cloudfront.net.evil/drops/asset.png',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).toThrow(`Chat drops with links are not allowed in this wave`);
  });

  it('allows chat drops with links when link disabling is off', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: false }),
        model: createChatDropModel({
          parts: [
            {
              content: 'see https://example.com',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
  });

  it('allows internal chat drops with links when link restrictions are bypassed', () => {
    const useCase = createUseCaseWithMocks();

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content: 'system update https://example.com',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: [],
        bypassChatLinkRestrictions: true
      })
    ).not.toThrow();
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

  it('reserves chat slow mode cooldown for non-admin chat drops', async () => {
    const wavesApiDb = {
      reserveWaveChatDropCooldown: jest.fn().mockResolvedValue(null)
    };
    const useCase = createUseCaseWithMocks({ wavesApiDb });

    await expect(
      (useCase as any).verifyChatSlowModeLimitations(
        {
          isDescriptionDrop: false,
          wave: createSlowModeWave(),
          model: createChatDropModel(),
          groupIdsUserIsEligibleFor: []
        },
        { connection: {} }
      )
    ).resolves.toBeUndefined();

    expect(wavesApiDb.reserveWaveChatDropCooldown).toHaveBeenCalledWith(
      expect.objectContaining({
        waveId: 'wave-1',
        profileId: 'author-profile',
        cooldownMs: 60000
      }),
      { timer: undefined, connection: {} }
    );
  });

  it('rejects non-admin chat drops while slow mode cooldown is active', async () => {
    const wavesApiDb = {
      reserveWaveChatDropCooldown: jest.fn().mockResolvedValue(12345)
    };
    const useCase = createUseCaseWithMocks({ wavesApiDb });

    await expect(
      (useCase as any).verifyChatSlowModeLimitations(
        {
          isDescriptionDrop: false,
          wave: createSlowModeWave(),
          model: createChatDropModel(),
          groupIdsUserIsEligibleFor: []
        },
        { connection: {} }
      )
    ).rejects.toThrow(
      'Slow mode is enabled. You can create your next chat drop at 12345'
    );
  });

  it('does not enforce chat slow mode when restrictions are bypassed', async () => {
    const wavesApiDb = {
      reserveWaveChatDropCooldown: jest.fn()
    };
    const useCase = createUseCaseWithMocks({ wavesApiDb });

    await expect(
      (useCase as any).verifyChatSlowModeLimitations(
        {
          isDescriptionDrop: false,
          wave: createSlowModeWave(),
          model: createChatDropModel(),
          groupIdsUserIsEligibleFor: [],
          bypassChatSlowModeRestrictions: true
        },
        { connection: {} }
      )
    ).resolves.toBeUndefined();

    expect(wavesApiDb.reserveWaveChatDropCooldown).not.toHaveBeenCalled();
  });

  it('does not enforce chat slow mode for wave admins', async () => {
    const wavesApiDb = {
      reserveWaveChatDropCooldown: jest.fn()
    };
    const useCase = createUseCaseWithMocks({ wavesApiDb });

    await expect(
      (useCase as any).verifyChatSlowModeLimitations(
        {
          isDescriptionDrop: false,
          wave: createSlowModeWave({ admin_group_id: 'admin-group' }),
          model: createChatDropModel(),
          groupIdsUserIsEligibleFor: ['admin-group']
        },
        { connection: {} }
      )
    ).resolves.toBeUndefined();

    expect(wavesApiDb.reserveWaveChatDropCooldown).not.toHaveBeenCalled();
  });

  it('does not enforce chat slow mode for participatory drops or edits', async () => {
    const wavesApiDb = {
      reserveWaveChatDropCooldown: jest.fn()
    };
    const useCase = createUseCaseWithMocks({ wavesApiDb });

    await expect(
      (useCase as any).verifyChatSlowModeLimitations(
        {
          isDescriptionDrop: false,
          wave: createSlowModeWave(),
          model: createChatDropModel({ drop_type: DropType.PARTICIPATORY }),
          groupIdsUserIsEligibleFor: []
        },
        { connection: {} }
      )
    ).resolves.toBeUndefined();

    await expect(
      (useCase as any).verifyChatSlowModeLimitations(
        {
          isDescriptionDrop: false,
          wave: createSlowModeWave(),
          model: createChatDropModel({ drop_id: 'drop-1' }),
          groupIdsUserIsEligibleFor: []
        },
        { connection: {} }
      )
    ).resolves.toBeUndefined();

    expect(wavesApiDb.reserveWaveChatDropCooldown).not.toHaveBeenCalled();
  });

  it('rejects pdf uploads from drop media URLs', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'application/pdf',
        url: `${CLOUDFRONT_LINK}/drops/author_1/file.pdf`,
        dropType: DropType.CHAT
      })
    ).toThrow('Unsupported mime type application/pdf');
  });

  it('rejects csv uploads from drop media URLs', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/csv',
        url: `${CLOUDFRONT_LINK}/drops/author_1/file.csv`,
        dropType: DropType.CHAT
      })
    ).toThrow('Unsupported mime type text/csv');
  });

  it('preserves html handling', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://arweave.net/some-html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('rejects html uploads from spoofed Arweave-like hosts', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://arweave.net.evil.com/file.html',
        dropType: DropType.CHAT
      })
    ).toThrow('text/html needs to be served from IPFS or Arweave');
  });

  it('preserves ipfs html handling', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'ipfs://bafybeigdyrzt/file.html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('accepts html uploads from the 6529 media resolver', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://media.6529.io/arweave/some-html/file.html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('accepts html uploads from recognized IPFS gateway URLs', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://ipfs.io/ipfs/bafybeigdyrzt/file.html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('accepts html uploads from recognized IPFS subdomain gateway URLs', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://bafybeigdyrzt.ipfs.nftstorage.link/file.html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('allows attachments owned by the author while they are still verifying', async () => {
    const useCase = createUseCaseWithMocks({
      attachmentsDb: {
        findAttachmentsByIds: jest.fn().mockResolvedValue({
          'attachment-1': {
            id: 'attachment-1',
            owner_profile_id: 'author-profile',
            status: AttachmentStatus.VERIFYING
          }
        })
      }
    });

    await expect(
      (useCase as any).verifyAttachments(
        {
          model: {
            author_id: 'author-profile',
            parts: [
              {
                attachments: [{ attachment_id: 'attachment-1' }]
              }
            ]
          }
        },
        { connection: {} }
      )
    ).resolves.toBeUndefined();
  });

  it('rejects attachments owned by another uploader', async () => {
    const useCase = createUseCaseWithMocks({
      attachmentsDb: {
        findAttachmentsByIds: jest.fn().mockResolvedValue({
          'attachment-1': {
            id: 'attachment-1',
            owner_profile_id: 'another-profile',
            status: AttachmentStatus.READY
          }
        })
      }
    });

    await expect(
      (useCase as any).verifyAttachments(
        {
          model: {
            author_id: 'author-profile',
            parts: [
              {
                attachments: [{ attachment_id: 'attachment-1' }]
              }
            ]
          }
        },
        { connection: {} }
      )
    ).rejects.toThrow(
      'Attachment attachment-1 does not belong to the uploader'
    );
  });

  it('rejects blocked attachments', async () => {
    const useCase = createUseCaseWithMocks({
      attachmentsDb: {
        findAttachmentsByIds: jest.fn().mockResolvedValue({
          'attachment-1': {
            id: 'attachment-1',
            owner_profile_id: 'author-profile',
            status: AttachmentStatus.BLOCKED
          }
        })
      }
    });

    await expect(
      (useCase as any).verifyAttachments(
        {
          model: {
            author_id: 'author-profile',
            parts: [
              {
                attachments: [{ attachment_id: 'attachment-1' }]
              }
            ]
          }
        },
        { connection: {} }
      )
    ).rejects.toThrow('Attachment attachment-1 is not usable');
  });
});
