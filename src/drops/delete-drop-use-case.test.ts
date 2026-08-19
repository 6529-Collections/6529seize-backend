import { identityFetcher } from '@/api-serverless/src/identities/identity.fetcher';
import { userGroupsService } from '@/api-serverless/src/community-members/user-groups.service';
import { waveScoreService } from '@/api/waves/wave-score.service';
import { waveDropMetricsRefreshService } from '@/drops/wave-drop-metrics-refresh.service';
import { DropType } from '@/entities/IDrop';
import { DeleteDropUseCase } from './delete-drop.use-case';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DeleteDropUseCase', () => {
  function createUseCase({
    drop,
    wave
  }: {
    drop?: Record<string, unknown> | null;
    wave?: Record<string, unknown> | null;
  }) {
    const dropsDb = {
      findDropById: jest.fn().mockResolvedValue(drop ?? null),
      findWaveByIdOrNull: jest.fn().mockResolvedValue(wave ?? null),
      deleteDropParts: jest.fn().mockResolvedValue(undefined),
      deleteDropMentions: jest.fn().mockResolvedValue(undefined),
      deleteDropMentionedWaves: jest.fn().mockResolvedValue(undefined),
      deleteDropGroupMentions: jest.fn().mockResolvedValue(undefined),
      deleteDropMedia: jest.fn().mockResolvedValue(undefined),
      deleteDropReferencedNfts: jest.fn().mockResolvedValue(undefined),
      deleteDropMetadata: jest.fn().mockResolvedValue(undefined),
      deleteDropEntity: jest.fn().mockResolvedValue(undefined),
      deleteDropFeedItems: jest.fn().mockResolvedValue(undefined),
      deleteDropNotifications: jest.fn().mockResolvedValue(undefined),
      deleteDropSubscriptions: jest.fn().mockResolvedValue(undefined),
      applyDeletedDropMetricsDelta: jest.fn().mockResolvedValue(undefined),
      insertDeletedDrop: jest.fn().mockResolvedValue(undefined)
    };
    const reactionsService = {
      deleteReactionsByDrop: jest.fn().mockResolvedValue(undefined)
    };
    const dropVotingService = {
      deleteVotes: jest.fn().mockResolvedValue(undefined)
    };
    const dropBookmarksDb = {
      deleteBookmarksByDropId: jest.fn().mockResolvedValue(undefined)
    };
    const curationsDb = {
      deleteDropCurationsByDropId: jest.fn().mockResolvedValue(undefined)
    };
    const artCurationTokenWatchService = {
      unregisterDrop: jest.fn().mockResolvedValue(undefined)
    };
    const attachmentsDb = {
      deleteDropAttachments: jest.fn().mockResolvedValue(undefined)
    };
    const dropPollsDb = {
      deleteByDropId: jest.fn().mockResolvedValue(undefined)
    };
    const wavesApiDb = {
      incrementDmUnreadStateVersionsForWaveReaders: jest
        .fn()
        .mockResolvedValue([]),
      findWaveById: jest.fn().mockResolvedValue(null)
    };

    return {
      useCase: new DeleteDropUseCase(
        reactionsService as any,
        dropVotingService as any,
        dropsDb as any,
        dropBookmarksDb as any,
        curationsDb as any,
        artCurationTokenWatchService as any,
        attachmentsDb as any,
        dropPollsDb as any,
        wavesApiDb as any
      ),
      dropsDb,
      artCurationTokenWatchService,
      attachmentsDb,
      dropPollsDb,
      wavesApiDb
    };
  }

  it('allows backend deletes without a user deleter and records the original drop author', async () => {
    const connection = {} as any;
    const drop = {
      id: 'drop-1',
      wave_id: 'wave-1',
      serial_no: 7,
      created_at: 123,
      author_id: 'drop-author',
      drop_type: DropType.PARTICIPATORY
    };
    const wave = {
      description_drop_id: 'description-drop',
      visibility_group_id: 'group-1'
    };
    const {
      useCase,
      dropsDb,
      artCurationTokenWatchService,
      attachmentsDb,
      dropPollsDb
    } = createUseCase({
      drop,
      wave
    });
    const getProfileIdByIdentityKeySpy = jest.spyOn(
      identityFetcher,
      'getProfileIdByIdentityKey'
    );
    const markWaveScoresDirtySpy = jest
      .spyOn(waveScoreService, 'markWaveScoresDirtyBestEffort')
      .mockResolvedValue(undefined);
    const markWaveDropMetricsDirtySpy = jest
      .spyOn(
        waveDropMetricsRefreshService,
        'markWaveDropMetricsDirtyBestEffort'
      )
      .mockResolvedValue(undefined);

    await expect(
      useCase.execute(
        {
          drop_id: 'drop-1',
          deletion_purpose: 'SYSTEM_DELETE'
        },
        { connection }
      )
    ).resolves.toEqual({
      id: 'drop-1',
      serial_no: 7,
      visibility_group_id: 'group-1',
      wave_id: 'wave-1',
      dm_unread_recipient_ids: []
    });

    expect(getProfileIdByIdentityKeySpy).not.toHaveBeenCalled();
    expect(artCurationTokenWatchService.unregisterDrop).toHaveBeenCalledWith(
      'drop-1',
      { timer: undefined, connection }
    );
    expect(attachmentsDb.deleteDropAttachments).toHaveBeenCalledWith('drop-1', {
      timer: undefined,
      connection
    });
    expect(dropPollsDb.deleteByDropId).toHaveBeenCalledWith('drop-1', {
      timer: undefined,
      connection
    });
    expect(dropsDb.applyDeletedDropMetricsDelta).toHaveBeenCalledWith(drop, {
      timer: undefined,
      connection
    });
    expect(markWaveDropMetricsDirtySpy).toHaveBeenCalledWith(
      ['wave-1'],
      'DROP_DELETED',
      {
        timer: undefined,
        connection
      }
    );
    expect(markWaveScoresDirtySpy).toHaveBeenCalledWith(
      ['wave-1'],
      'DROP_DELETED',
      {
        timer: undefined,
        connection
      }
    );
    expect(dropsDb.insertDeletedDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'drop-author',
        created_at: 123,
        deleted_at: expect.any(Number)
      }),
      { timer: undefined, connection }
    );
  });

  it('still requires a deleter identity for user-initiated deletes', async () => {
    const { useCase } = createUseCase({});

    await expect(
      useCase.execute(
        {
          drop_id: 'drop-1',
          deletion_purpose: 'DELETE'
        },
        { connection: {} as any }
      )
    ).rejects.toThrow(`deleter_identity is required`);
  });

  it('increments reader versions when permanently deleting a DM drop', async () => {
    const connection = {} as any;
    const { useCase, wavesApiDb } = createUseCase({
      drop: {
        id: 'drop-1',
        wave_id: 'wave-1',
        serial_no: 7,
        created_at: 123,
        author_id: 'drop-author',
        drop_type: DropType.CHAT
      },
      wave: {
        description_drop_id: 'description-drop',
        visibility_group_id: null,
        chat_group_id: 'dm-group',
        parent_wave_id: null,
        is_direct_message: true
      }
    });
    jest
      .spyOn(userGroupsService, 'findIdentitiesInGroups')
      .mockResolvedValue(['reader-1']);
    wavesApiDb.incrementDmUnreadStateVersionsForWaveReaders.mockResolvedValue([
      'reader-1'
    ]);

    await expect(
      useCase.execute(
        {
          drop_id: 'drop-1',
          deletion_purpose: 'SYSTEM_DELETE'
        },
        { connection }
      )
    ).resolves.toMatchObject({
      dm_unread_recipient_ids: ['reader-1']
    });

    expect(
      wavesApiDb.incrementDmUnreadStateVersionsForWaveReaders
    ).toHaveBeenCalledWith(
      { waveId: 'wave-1', readerIds: ['reader-1'] },
      { timer: undefined, connection }
    );
  });

  it('excludes readers who no longer satisfy DM and parent visibility', async () => {
    const connection = {} as any;
    const { useCase, wavesApiDb } = createUseCase({
      drop: {
        id: 'drop-1',
        wave_id: 'wave-1',
        serial_no: 7,
        created_at: 123,
        author_id: 'drop-author',
        drop_type: DropType.CHAT
      },
      wave: {
        description_drop_id: 'description-drop',
        visibility_group_id: 'wave-visible',
        chat_group_id: 'dm-group',
        parent_wave_id: 'parent-wave',
        is_direct_message: true
      }
    });
    wavesApiDb.findWaveById.mockResolvedValue({
      visibility_group_id: 'parent-visible'
    });
    jest
      .spyOn(userGroupsService, 'findIdentitiesInGroups')
      .mockImplementation(async ([groupId]) => {
        if (groupId === 'dm-group') {
          return ['current-reader', 'former-reader', 'parent-blocked'];
        }
        if (groupId === 'wave-visible') {
          return ['current-reader', 'parent-blocked'];
        }
        return ['current-reader'];
      });
    wavesApiDb.incrementDmUnreadStateVersionsForWaveReaders.mockResolvedValue([
      'current-reader'
    ]);

    await useCase.execute(
      { drop_id: 'drop-1', deletion_purpose: 'SYSTEM_DELETE' },
      { connection }
    );

    expect(
      wavesApiDb.incrementDmUnreadStateVersionsForWaveReaders
    ).toHaveBeenCalledWith(
      { waveId: 'wave-1', readerIds: ['current-reader'] },
      { timer: undefined, connection }
    );
  });

  it('resolves deleter identity using the caller transaction context', async () => {
    const { useCase } = createUseCase({});
    const connection = {} as any;
    const timer = {} as any;
    const getProfileIdByIdentityKeySpy = jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKey')
      .mockResolvedValue('deleter-profile-id');

    await expect(
      useCase.execute(
        {
          drop_id: 'drop-1',
          deleter_identity: '0xabc',
          deletion_purpose: 'DELETE'
        },
        { timer, connection }
      )
    ).resolves.toBeNull();

    expect(getProfileIdByIdentityKeySpy).toHaveBeenCalledWith(
      {
        identityKey: '0xabc'
      },
      { timer, connection }
    );
  });

  it("allows wave creators to delete another user's drop when admin drop deletion is enabled", async () => {
    const connection = {} as any;
    const drop = {
      id: 'drop-1',
      wave_id: 'wave-1',
      serial_no: 7,
      created_at: 123,
      author_id: 'drop-author',
      drop_type: DropType.PARTICIPATORY
    };
    const wave = {
      description_drop_id: 'description-drop',
      visibility_group_id: 'group-1',
      created_by: 'wave-creator',
      admin_group_id: null,
      admin_drop_deletion_enabled: true
    };
    const { useCase, dropsDb } = createUseCase({ drop, wave });
    const getGroupsUserIsEligibleForSpy = jest.spyOn(
      userGroupsService,
      'getGroupsUserIsEligibleFor'
    );

    await expect(
      useCase.execute(
        {
          drop_id: 'drop-1',
          deleter_id: 'wave-creator',
          deletion_purpose: 'DELETE'
        },
        { connection }
      )
    ).resolves.toEqual({
      id: 'drop-1',
      serial_no: 7,
      visibility_group_id: 'group-1',
      wave_id: 'wave-1',
      dm_unread_recipient_ids: []
    });

    expect(getGroupsUserIsEligibleForSpy).not.toHaveBeenCalled();
    expect(dropsDb.insertDeletedDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'drop-author'
      }),
      { timer: undefined, connection }
    );
  });

  it("allows admin group members to delete another user's drop when admin drop deletion is enabled", async () => {
    const connection = {} as any;
    const drop = {
      id: 'drop-1',
      wave_id: 'wave-1',
      serial_no: 7,
      created_at: 123,
      author_id: 'drop-author',
      drop_type: DropType.PARTICIPATORY
    };
    const wave = {
      description_drop_id: 'description-drop',
      visibility_group_id: 'group-1',
      created_by: 'wave-creator',
      admin_group_id: 'admin-group',
      admin_drop_deletion_enabled: true
    };
    const { useCase } = createUseCase({ drop, wave });
    jest
      .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
      .mockResolvedValue(['admin-group']);

    await expect(
      useCase.execute(
        {
          drop_id: 'drop-1',
          deleter_id: 'admin-profile',
          deletion_purpose: 'DELETE'
        },
        { connection }
      )
    ).resolves.toEqual({
      id: 'drop-1',
      serial_no: 7,
      visibility_group_id: 'group-1',
      wave_id: 'wave-1',
      dm_unread_recipient_ids: []
    });
  });
});
