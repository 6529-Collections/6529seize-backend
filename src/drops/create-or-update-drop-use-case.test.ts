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
import { Logger } from '@/logging';
import { Time } from '@/time';
import {
  CreateOrUpdateDropUseCase,
  normalizeDropGroupMentions,
  sanitizeDropStructuredFields,
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
      {} as any,
      {} as any
    );
  }

  function createUseCaseWithMocks(
    overrides: {
      dropsDb?: any;
      wavesApiDb?: any;
      userGroupsService?: any;
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
      overrides.userGroupsService ?? ({} as any),
      overrides.wavesApiDb ?? ({} as any),
      overrides.userNotifier ?? ({} as any),
      {} as any,
      overrides.identitySubscriptionsDb ?? ({} as any),
      {} as any,
      overrides.deleteDropUseCase ?? ({} as any),
      {} as any,
      {} as any,
      overrides.artCurationTokenWatchService ?? ({} as any),
      overrides.attachmentsDb ?? ({} as any),
      {} as any
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
      reply_to: null,
      title: null,
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
      referenced_nfts: [],
      mentioned_users: [],
      mentioned_waves: [],
      metadata: [],
      mentioned_groups: [],
      signature: null,
      is_additional_action_promised: null,
      ...overrides
    };
  }

  function createNotificationDropModel(
    overrides: Record<string, unknown> = {}
  ) {
    return {
      drop_id: 'drop-1',
      wave_id: 'wave-1',
      author_id: 'author-1',
      reply_to: null,
      parts: [],
      mentioned_groups: [],
      ...overrides
    };
  }

  it('sanitizes structured drop fields without touching part content', () => {
    const model = {
      ...createChatDropModel(),
      title: '  The Loom  ',
      parts: [
        {
          content: '  keep chat text as typed  ',
          quoted_drop: null,
          media: []
        }
      ],
      metadata: [
        {
          data_key: ' artist ',
          data_value: '  6529er  '
        },
        {
          data_key: ' empty ',
          data_value: '   '
        }
      ]
    };

    const sanitized = sanitizeDropStructuredFields(model);

    expect(sanitized).toMatchObject({
      title: 'The Loom',
      parts: [
        {
          content: '  keep chat text as typed  '
        }
      ],
      metadata: [
        {
          data_key: 'artist',
          data_value: '6529er'
        }
      ]
    });
    expect(sanitized.metadata).toHaveLength(1);
    expect(model.metadata[0]).toMatchObject({
      data_key: ' artist ',
      data_value: '  6529er  '
    });
  });

  it('keeps identity nomination pre-resolution best-effort for empty metadata after trimming', async () => {
    const useCase = createUseCase({ existingNominations: [] });

    await expect(
      useCase.preResolveIdentityNomination(
        {
          ...createIdentitySubmissionModel('   '),
          metadata: [
            {
              data_key: ' identity ',
              data_value: '   '
            }
          ]
        },
        {}
      )
    ).resolves.toBeNull();
  });

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

  it('strips ALL group mention metadata when the drop content has no @all token', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [
          {
            content:
              'Round 10 Vote Reconciliation\n\n@[MoonZoey] and @[QuantumSpirit]'
          }
        ]
      })
    ).toEqual([]);
  });

  it('keeps ALL group mention metadata for standalone @all tokens', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [
          {
            content: 'Heads up @all: please review this drop.'
          }
        ]
      })
    ).toEqual([DropGroupMention.ALL]);
  });

  it('keeps ALL group mention metadata when @all is in a later part', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [
          {
            content: 'first part'
          },
          {
            content: 'second part with @all'
          }
        ]
      })
    ).toEqual([DropGroupMention.ALL]);
  });

  it('keeps ALL group mention metadata for case-insensitive @all tokens', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [
          {
            content: 'Heads up @ALL'
          }
        ]
      })
    ).toEqual([DropGroupMention.ALL]);
  });

  it('keeps ALL group mention metadata for line-start @all tokens', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [
          {
            content: 'first line\n@all on the next line'
          }
        ]
      })
    ).toEqual([DropGroupMention.ALL]);
  });

  it('does not treat embedded @all text as an ALL group mention', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [
          {
            content: 'email@example.com @alliance hello@all @all_again'
          }
        ]
      })
    ).toEqual([]);
  });

  it('strips ALL group mention metadata when there are no drop parts', () => {
    expect(
      normalizeDropGroupMentions({
        parts: []
      })
    ).toEqual([]);
  });

  it('derives group mention metadata from raw typed content', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [
          {
            content: '@all'
          }
        ]
      })
    ).toEqual([DropGroupMention.ALL]);
  });

  it('derives all reserved global mentions case-insensitively', () => {
    expect(
      normalizeDropGroupMentions({
        parts: [{ content: '@Contributors @ADMINS @DeVs6529' }]
      })
    ).toEqual([
      DropGroupMention.CONTRIBUTORS,
      DropGroupMention.ADMINS,
      DropGroupMention.DEVS_6529
    ]);
  });

  it('replaces edited group metadata with the mentions in edited content', () => {
    const useCase = createUseCase({ existingNominations: [] });

    expect(
      (useCase as any).normalizeMentionedGroups({
        ...createChatDropModel({
          drop_id: 'existing-drop',
          parts: [
            {
              content: 'updated for @contributors',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        mentioned_groups: [DropGroupMention.ADMINS]
      }).mentioned_groups
    ).toEqual([DropGroupMention.CONTRIBUTORS]);
  });

  it('allows chat participants to use permission-derived group mentions', () => {
    const useCase = createUseCase({ existingNominations: [] });
    expect(() =>
      (useCase as any).verifyGroupMentions({
        model: {
          ...createGroupMentionModel(),
          mentioned_groups: [
            DropGroupMention.CONTRIBUTORS,
            DropGroupMention.ADMINS,
            DropGroupMention.DEVS_6529
          ]
        },
        wave: { created_by: 'another-profile', admin_group_id: 'admins' },
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
  });

  it('allows chat participants to invoke @devs6529 like direct developer mentions', () => {
    const useCase = createUseCase({ existingNominations: [] });

    expect(() =>
      (useCase as any).verifyGroupMentions({
        model: {
          ...createGroupMentionModel(),
          mentioned_groups: [DropGroupMention.DEVS_6529]
        },
        wave: { created_by: 'another-profile', admin_group_id: 'admins' },
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
  });

  it('rate-limits missing developer mention configuration warnings', () => {
    const warn = jest
      .spyOn(Logger.get(CreateOrUpdateDropUseCase.name), 'warn')
      .mockImplementation();
    let now = 1_000;
    jest.spyOn(Time, 'currentMillis').mockImplementation(() => now);
    const useCase = createUseCase({ existingNominations: [] });
    const model = {
      ...createGroupMentionModel(),
      mentioned_groups: [DropGroupMention.DEVS_6529]
    };

    (useCase as any).warnIfDeveloperMentionHasNoRecipients({
      model,
      configuredDeveloperIds: []
    });
    now = 301_000;
    (useCase as any).warnIfDeveloperMentionHasNoRecipients({
      model,
      configuredDeveloperIds: []
    });
    (useCase as any).warnIfDeveloperMentionHasNoRecipients({
      model,
      configuredDeveloperIds: []
    });

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('normalizes group mention metadata idempotently', () => {
    const parts = [{ content: 'hello @all' }];
    const once = normalizeDropGroupMentions({
      parts
    });

    expect(
      normalizeDropGroupMentions({
        parts
      })
    ).toEqual(once);
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

  it('rejects @all mentions from non-admins', () => {
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
    ).toThrow(`Only wave creators or admins can mention @all`);
  });

  it('allows group mentions on drop updates', () => {
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
    ).not.toThrow();
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

  it('allows GIF provider media links when chat links are disabled', () => {
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

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content:
                'reaction https://media1.giphy.com/media/abc123/giphy.gif',
              quoted_drop: null,
              media: []
            }
          ]
        }),
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();
  });

  it('allows only configured GIF provider file extensions in chat link allowlist', () => {
    const useCase = createUseCaseWithMocks();

    for (const extension of ['gif', 'mp4', 'jpg', 'webp']) {
      expect(
        (useCase as any).isAllowedChatLink(
          `https://media.tenor.com/abc123/tenor.${extension}?item=1`
        )
      ).toBe(true);
      expect(
        (useCase as any).isAllowedChatLink(
          `https://media1.giphy.com/media/abc123/giphy.${extension}?cid=1`
        )
      ).toBe(true);
    }
    for (const extension of ['jpeg', 'png', 'html']) {
      expect(
        (useCase as any).isAllowedChatLink(
          `https://media.tenor.com/abc123/tenor.${extension}`
        )
      ).toBe(false);
      expect(
        (useCase as any).isAllowedChatLink(
          `https://media.giphy.com/media/abc123/giphy.${extension}`
        )
      ).toBe(false);
    }
    expect(
      (useCase as any).isAllowedChatLink('https://media.tenor.com/abc123/tenor')
    ).toBe(false);
    expect(
      (useCase as any).isAllowedChatLink(
        'https://media.giphy.com/media/abc/giphy'
      )
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

  it('seeds missing reader metrics before a new direct-message drop', async () => {
    const connection = {};
    const wave = {
      ...createSlowModeWave({
        chat_slow_mode_cooldown_ms: null,
        is_direct_message: true,
        visibility_group_id: 'visibility-group',
        participation_group_id: 'participation-group',
        chat_group_id: 'chat-dm-group',
        admin_group_id: 'admin-group',
        voting_group_id: 'voting-group'
      }),
      type: WaveType.CHAT,
      next_decision_time: null
    };
    const wavesApiDb = {
      findExistingWaveReaderMetricReaderIds: jest.fn().mockResolvedValue([]),
      insertMissingWaveReaderMetrics: jest.fn().mockResolvedValue(undefined)
    };
    const userGroupsService = {
      findIdentitiesInGroups: jest
        .fn()
        .mockResolvedValue(['author-profile', 'reader-profile'])
    };
    const useCase = createUseCaseWithMocks({
      wavesApiDb,
      userGroupsService
    });

    await (useCase as any).ensureDirectMessageReaderMetricsForNewDrop(
      {
        wave,
        authorId: 'author-profile',
        createdAt: 1400
      },
      { connection }
    );

    expect(userGroupsService.findIdentitiesInGroups).toHaveBeenCalledWith(
      ['chat-dm-group'],
      { timer: undefined, connection }
    );
    expect(
      wavesApiDb.findExistingWaveReaderMetricReaderIds
    ).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        readerIds: ['reader-profile']
      },
      { timer: undefined, connection }
    );
    expect(wavesApiDb.insertMissingWaveReaderMetrics).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        readerIds: ['reader-profile'],
        latestReadTimestamp: 1399
      },
      { timer: undefined, connection }
    );
  });

  it('skips direct-message reader metric seeding when recipients already have metrics', async () => {
    const connection = {};
    const wave = {
      ...createSlowModeWave({
        chat_slow_mode_cooldown_ms: null,
        is_direct_message: true,
        chat_group_id: 'chat-dm-group'
      }),
      type: WaveType.CHAT,
      next_decision_time: null
    };
    const wavesApiDb = {
      findExistingWaveReaderMetricReaderIds: jest
        .fn()
        .mockResolvedValue(['reader-profile']),
      insertMissingWaveReaderMetrics: jest.fn().mockResolvedValue(undefined)
    };
    const userGroupsService = {
      findIdentitiesInGroups: jest
        .fn()
        .mockResolvedValue(['author-profile', 'reader-profile'])
    };
    const useCase = createUseCaseWithMocks({
      wavesApiDb,
      userGroupsService
    });

    await (useCase as any).ensureDirectMessageReaderMetricsForNewDrop(
      {
        wave,
        authorId: 'author-profile',
        createdAt: 1400
      },
      { connection }
    );

    expect(wavesApiDb.insertMissingWaveReaderMetrics).not.toHaveBeenCalled();
  });

  it('allows scheme-less GIF provider candidates in chat link allowlist', () => {
    const useCase = createUseCaseWithMocks();

    expect(
      (useCase as any).isAllowedChatLink('media.tenor.com/abc123/tenor.gif')
    ).toBe(true);
    expect(
      (useCase as any).isAllowedChatLink('//media.tenor.com/abc123/tenor.gif')
    ).toBe(true);
    expect(
      (useCase as any).isAllowedChatLink(
        'media1.giphy.com/media/abc123/giphy.gif'
      )
    ).toBe(true);
    expect(
      (useCase as any).isAllowedChatLink(
        '//media.giphy.com/media/abc123/giphy.gif'
      )
    ).toBe(true);
    expect(
      (useCase as any).isAllowedChatLink(
        'media.tenor.com.evil/abc123/tenor.gif'
      )
    ).toBe(false);
    expect(
      (useCase as any).isAllowedChatLink(
        'media.giphy.com.evil/media/abc123/giphy.gif'
      )
    ).toBe(false);
  });

  it('rejects mixed GIF provider and non-provider links when chat links are disabled', () => {
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

  it('rejects GIF provider lookalike links when chat links are disabled', () => {
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

    expect(() =>
      (useCase as any).verifyChatLinksAreAllowed({
        isDescriptionDrop: false,
        wave: createSlowModeWave({ chat_links_disabled: true }),
        model: createChatDropModel({
          parts: [
            {
              content:
                'fake https://media.giphy.com.evil/media/abc123/giphy.gif',
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
          model: createNotificationDropModel({
            mentioned_groups: [DropGroupMention.ALL]
          }),
          wave: {
            id: 'wave-1',
            visibility_group_id: null
          },
          directlyMentionedIdentityIds: ['direct-1', 'direct-muted'],
          groupMentionNotificationsEnabled: true
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
        replyNotification: null,
        quoteNotifications: [],
        mentionedIdentityIds: ['direct-1', 'group-mention-1', 'both-1'],
        allDropsSubscriberIds: []
      },
      null,
      { timer: undefined, connection: {} }
    );
  });

  it('filters direct mentions to identities eligible for a private wave', async () => {
    const userGroupsService = {
      findIdentitiesInGroups: jest.fn().mockResolvedValue(['eligible-mention'])
    };
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([]),
      countWaveSubscribers: jest.fn().mockResolvedValue(0),
      findMutedWaveReaders: jest.fn().mockResolvedValue([])
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([101])
    };
    const useCase = createUseCaseWithMocks({
      userGroupsService,
      identitySubscriptionsDb,
      userNotifier
    });

    await expect(
      (useCase as any).notifyWaveDropRecipients(
        {
          model: createNotificationDropModel(),
          wave: {
            id: 'wave-1',
            visibility_group_id: 'private-group',
            parent_wave_id: null
          },
          directlyMentionedIdentityIds: [
            'eligible-mention',
            'ineligible-mention'
          ]
        },
        { connection: {} }
      )
    ).resolves.toEqual([101]);

    expect(userGroupsService.findIdentitiesInGroups).toHaveBeenCalledWith(
      ['private-group'],
      { timer: undefined, connection: {} }
    );
    expect(identitySubscriptionsDb.findMutedWaveReaders).toHaveBeenCalledWith(
      'wave-1',
      ['eligible-mention'],
      {}
    );
    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: null,
        quoteNotifications: [],
        mentionedIdentityIds: ['eligible-mention'],
        allDropsSubscriberIds: []
      },
      'private-group',
      { timer: undefined, connection: {} }
    );
  });

  it('deduplicates direct mentions for a public wave without group lookups', async () => {
    const userGroupsService = {
      findIdentitiesInGroups: jest.fn()
    };
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([]),
      countWaveSubscribers: jest.fn().mockResolvedValue(0),
      findMutedWaveReaders: jest.fn().mockResolvedValue([])
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([103])
    };
    const useCase = createUseCaseWithMocks({
      userGroupsService,
      identitySubscriptionsDb,
      userNotifier
    });

    await (useCase as any).notifyWaveDropRecipients(
      {
        model: createNotificationDropModel(),
        wave: {
          id: 'public-wave',
          visibility_group_id: null,
          parent_wave_id: null
        },
        directlyMentionedIdentityIds: ['public-mention', 'public-mention']
      },
      { connection: {} }
    );

    expect(userGroupsService.findIdentitiesInGroups).not.toHaveBeenCalled();
    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'public-wave',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: null,
        quoteNotifications: [],
        mentionedIdentityIds: ['public-mention'],
        allDropsSubscriberIds: []
      },
      null,
      { timer: undefined, connection: {} }
    );
  });

  it('resolves reply and quote notification context in one drop lookup', async () => {
    const dropsDb = {
      getDropsByIds: jest.fn().mockResolvedValue([
        { id: 'replied-drop', author_id: 'relationship-recipient' },
        { id: 'quoted-drop', author_id: 'relationship-recipient' }
      ])
    };
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([]),
      countWaveSubscribers: jest.fn().mockResolvedValue(0),
      findMutedWaveReaders: jest.fn().mockResolvedValue([])
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([104])
    };
    const useCase = createUseCaseWithMocks({
      dropsDb,
      identitySubscriptionsDb,
      userNotifier
    });

    await (useCase as any).notifyWaveDropRecipients(
      {
        model: createNotificationDropModel({
          reply_to: {
            drop_id: 'replied-drop',
            drop_part_id: 1
          },
          parts: [
            {
              content: 'reply',
              quoted_drop: null,
              media: []
            },
            {
              content: 'quote',
              quoted_drop: {
                drop_id: 'quoted-drop',
                drop_part_id: 2
              },
              media: []
            }
          ]
        }),
        wave: {
          id: 'wave-1',
          visibility_group_id: null,
          parent_wave_id: null
        },
        directlyMentionedIdentityIds: ['relationship-recipient'],
        groupMentionNotificationsEnabled: true
      },
      { connection: {} }
    );

    expect(dropsDb.getDropsByIds).toHaveBeenCalledWith(
      ['replied-drop', 'quoted-drop'],
      {}
    );
    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: {
          reply_drop_id: 'drop-1',
          reply_drop_author_id: 'author-1',
          replied_drop_id: 'replied-drop',
          replied_drop_part: 1,
          replied_drop_author_id: 'relationship-recipient',
          wave_id: 'wave-1'
        },
        quoteNotifications: [
          {
            quote_drop_id: 'drop-1',
            quote_drop_part: 2,
            quote_drop_author_id: 'author-1',
            quoted_drop_id: 'quoted-drop',
            quoted_drop_part: 2,
            quoted_drop_author_id: 'relationship-recipient',
            wave_id: 'wave-1'
          }
        ],
        mentionedIdentityIds: ['relationship-recipient'],
        allDropsSubscriberIds: []
      },
      null,
      { timer: undefined, connection: {} }
    );
  });

  it('requires direct mentions to access both child and parent waves', async () => {
    const userGroupsService = {
      findIdentitiesInGroups: jest
        .fn()
        .mockResolvedValueOnce(['child-and-parent', 'child-only'])
        .mockResolvedValueOnce(['child-and-parent'])
    };
    const wavesApiDb = {
      findWaveById: jest.fn().mockResolvedValue({
        id: 'parent-wave',
        visibility_group_id: 'parent-group'
      })
    };
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([]),
      countWaveSubscribers: jest.fn().mockResolvedValue(0),
      findMutedWaveReaders: jest.fn().mockResolvedValue([])
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([102])
    };
    const useCase = createUseCaseWithMocks({
      userGroupsService,
      wavesApiDb,
      identitySubscriptionsDb,
      userNotifier
    });

    await (useCase as any).notifyWaveDropRecipients(
      {
        model: createNotificationDropModel(),
        wave: {
          id: 'child-wave',
          visibility_group_id: 'child-group',
          parent_wave_id: 'parent-wave'
        },
        directlyMentionedIdentityIds: ['child-and-parent', 'child-only']
      },
      { connection: {} }
    );

    expect(wavesApiDb.findWaveById).toHaveBeenCalledWith('parent-wave', {});
    expect(userGroupsService.findIdentitiesInGroups).toHaveBeenNthCalledWith(
      1,
      ['child-group'],
      { timer: undefined, connection: {} }
    );
    expect(userGroupsService.findIdentitiesInGroups).toHaveBeenNthCalledWith(
      2,
      ['parent-group'],
      { timer: undefined, connection: {} }
    );
    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'child-wave',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: null,
        quoteNotifications: [],
        mentionedIdentityIds: ['child-and-parent'],
        allDropsSubscriberIds: []
      },
      'child-group',
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
          model: createNotificationDropModel({
            mentioned_groups: [DropGroupMention.ALL]
          }),
          wave: {
            id: 'wave-1',
            visibility_group_id: null
          },
          directlyMentionedIdentityIds: ['direct-1'],
          groupMentionNotificationsEnabled: true
        },
        { connection: {} }
      )
    ).resolves.toEqual([102]);

    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: null,
        quoteNotifications: [],
        mentionedIdentityIds: ['direct-1', 'group-mention-1', 'both-1'],
        allDropsSubscriberIds: ['all-drops-1']
      },
      null,
      { timer: undefined, connection: {} }
    );
  });

  it('does not resend any group mentions when editing a drop', async () => {
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([]),
      countWaveSubscribers: jest.fn().mockResolvedValue(0),
      findMutedWaveReaders: jest.fn().mockResolvedValue([])
    };
    const userGroupsService = {
      findIdentityGroupMemberships: jest.fn(),
      findIdentityGroupMembershipPage: jest.fn()
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([])
    };
    const useCase = createUseCaseWithMocks({
      identitySubscriptionsDb,
      userGroupsService,
      userNotifier
    });

    await (useCase as any).notifyWaveDropRecipients(
      {
        model: createNotificationDropModel({
          mentioned_groups: [DropGroupMention.ALL, DropGroupMention.ADMINS]
        }),
        wave: { id: 'wave-1', visibility_group_id: null },
        directlyMentionedIdentityIds: [],
        groupMentionNotificationsEnabled: false
      },
      { connection: {} }
    );

    expect(
      identitySubscriptionsDb.findWaveFollowersEligibleForDropNotifications
    ).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        authorId: 'author-1',
        mentionedGroups: []
      },
      {}
    );
    expect(
      userGroupsService.findIdentityGroupMemberships
    ).not.toHaveBeenCalled();
    expect(
      userGroupsService.findIdentityGroupMembershipPage
    ).not.toHaveBeenCalled();
  });

  it('resolves contributors, admins, and configured developers with view access', async () => {
    jest
      .spyOn(env, 'getStringArray')
      .mockReturnValue([' developer-1 ', 'hidden-developer']);
    jest
      .spyOn(identitiesDb, 'getIdentitiesByIds')
      .mockResolvedValue([
        { profile_id: 'developer-1' },
        { profile_id: 'hidden-developer' }
      ] as any);
    const userGroupsService = {
      findIdentityGroupMembershipPage: jest.fn().mockResolvedValue({
        memberships: [
          { groupId: 'chatters', profileId: 'contributor-1' },
          { groupId: 'chatters', profileId: 'hidden-contributor' },
          { groupId: 'admins', profileId: 'admin-1' },
          { groupId: 'admins', profileId: 'hidden-admin' }
        ],
        nextCursor: null
      }),
      findIdentityGroupMemberships: jest.fn().mockResolvedValue([
        { groupId: 'visible', profileId: 'contributor-1' },
        { groupId: 'visible', profileId: 'admin-1' },
        { groupId: 'visible', profileId: 'creator' },
        { groupId: 'visible', profileId: 'developer-1' }
      ])
    };
    const useCase = createUseCaseWithMocks({ userGroupsService });

    await expect(
      (useCase as any).resolvePermissionGroupMentionRecipients(
        {
          model: {
            mentioned_groups: [
              DropGroupMention.CONTRIBUTORS,
              DropGroupMention.ADMINS,
              DropGroupMention.DEVS_6529
            ]
          },
          wave: {
            created_by: 'creator',
            chat_group_id: 'chatters',
            admin_group_id: 'admins',
            visibility_group_id: 'visible'
          },
          followerIdentityIds: []
        },
        { timer: undefined, connection: {} }
      )
    ).resolves.toEqual(['contributor-1', 'admin-1', 'developer-1', 'creator']);
    expect(
      userGroupsService.findIdentityGroupMembershipPage
    ).toHaveBeenCalledWith(
      {
        groupIds: ['chatters', 'admins'],
        after: null
      },
      { timer: undefined, connection: {} }
    );
    expect(userGroupsService.findIdentityGroupMemberships).toHaveBeenCalledWith(
      {
        groupIds: ['visible'],
        profileIds: [
          'contributor-1',
          'hidden-contributor',
          'admin-1',
          'hidden-admin',
          'developer-1',
          'hidden-developer',
          'creator'
        ]
      },
      { timer: undefined, connection: {} }
    );
  });

  it('treats all eligible followers as contributors when Chat access is Anyone', async () => {
    const userGroupsService = {
      findIdentityGroupMemberships: jest.fn(),
      findIdentityGroupMembershipPage: jest.fn()
    };
    const useCase = createUseCaseWithMocks({ userGroupsService });

    expect(() =>
      (useCase as any).verifyGroupMentions({
        model: {
          ...createGroupMentionModel(),
          mentioned_groups: [DropGroupMention.CONTRIBUTORS]
        },
        wave: { created_by: 'another-profile', admin_group_id: 'admins' },
        groupIdsUserIsEligibleFor: []
      })
    ).not.toThrow();

    await expect(
      (useCase as any).resolvePermissionGroupMentionRecipients(
        {
          model: {
            mentioned_groups: [DropGroupMention.CONTRIBUTORS]
          },
          wave: {
            created_by: 'creator',
            chat_group_id: null,
            admin_group_id: null,
            visibility_group_id: null
          },
          followerIdentityIds: ['follower-1', 'follower-2']
        },
        { timer: undefined, connection: {} }
      )
    ).resolves.toEqual(['follower-1', 'follower-2']);
    expect(
      userGroupsService.findIdentityGroupMemberships
    ).not.toHaveBeenCalled();
    expect(
      userGroupsService.findIdentityGroupMembershipPage
    ).not.toHaveBeenCalled();
  });

  it('removes muted followers from fully open contributor notifications', async () => {
    const identitySubscriptionsDb = {
      findWaveFollowersEligibleForDropNotifications: jest
        .fn()
        .mockResolvedValue([
          {
            identity_id: 'follower-1',
            subscribed_to_all_drops: false,
            has_group_mention: false
          },
          {
            identity_id: 'follower-2',
            subscribed_to_all_drops: false,
            has_group_mention: false
          }
        ]),
      countWaveSubscribers: jest.fn().mockResolvedValue(20),
      findMutedWaveReaders: jest.fn().mockResolvedValue(['follower-2'])
    };
    const userNotifier = {
      notifyWaveDropCreatedRecipients: jest.fn().mockResolvedValue([])
    };
    const useCase = createUseCaseWithMocks({
      identitySubscriptionsDb,
      userNotifier
    });

    await (useCase as any).notifyWaveDropRecipients(
      {
        model: createNotificationDropModel({
          mentioned_groups: [DropGroupMention.CONTRIBUTORS]
        }),
        wave: {
          id: 'wave-1',
          created_by: 'author-1',
          chat_group_id: null,
          admin_group_id: null,
          visibility_group_id: null
        },
        directlyMentionedIdentityIds: [],
        groupMentionNotificationsEnabled: true
      },
      { connection: {} }
    );

    expect(userNotifier.notifyWaveDropCreatedRecipients).toHaveBeenCalledWith(
      {
        waveId: 'wave-1',
        dropId: 'drop-1',
        relatedIdentityId: 'author-1',
        replyNotification: null,
        quoteNotifications: [],
        mentionedIdentityIds: ['follower-1'],
        allDropsSubscriberIds: []
      },
      null,
      { timer: undefined, connection: {} }
    );
  });

  it('filters the wave creator and configured developers by wave visibility', async () => {
    jest.spyOn(env, 'getStringArray').mockReturnValue(['hidden-developer']);
    jest
      .spyOn(identitiesDb, 'getIdentitiesByIds')
      .mockResolvedValue([{ profile_id: 'hidden-developer' }] as any);
    const userGroupsService = {
      findIdentityGroupMemberships: jest.fn().mockResolvedValue([])
    };
    const useCase = createUseCaseWithMocks({ userGroupsService });

    await expect(
      (useCase as any).resolvePermissionGroupMentionRecipients(
        {
          model: {
            mentioned_groups: [
              DropGroupMention.ADMINS,
              DropGroupMention.DEVS_6529
            ]
          },
          wave: {
            created_by: 'hidden-creator',
            chat_group_id: null,
            admin_group_id: null,
            visibility_group_id: 'visible'
          },
          followerIdentityIds: []
        },
        { timer: undefined, connection: {} }
      )
    ).resolves.toEqual([]);
    expect(userGroupsService.findIdentityGroupMemberships).toHaveBeenCalledWith(
      {
        groupIds: ['visible'],
        profileIds: ['hidden-developer', 'hidden-creator']
      },
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
        url: 'https://arweave.net/OI6-rpJ2C3Ab4HiZRWt5A1SumhjnYigmSPBPX0ICBj8',
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
    ).toThrow('text/html needs to be served from IPFS, IPNS, or Arweave');
  });

  it('preserves ipfs html handling', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/file.html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('accepts html uploads from the 6529 media resolver', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://media.6529.io/arweave/OI6-rpJ2C3Ab4HiZRWt5A1SumhjnYigmSPBPX0ICBj8/file.html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('accepts html uploads from recognized IPFS gateway URLs', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/file.html',
        dropType: DropType.CHAT
      })
    ).not.toThrow();
  });

  it('accepts html uploads from recognized IPFS subdomain gateway URLs', () => {
    expect(() =>
      validateDropMediaAttachment({
        mimeType: 'text/html',
        url: 'https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.nftstorage.link/file.html',
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
