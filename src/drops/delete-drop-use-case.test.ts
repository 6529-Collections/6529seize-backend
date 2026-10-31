jest.mock('@/competitions/legacy-competition-mutation', () => ({
  withLegacyPrimaryMutation: jest.fn(
    (_wave: string, _ctx: unknown, action: (owner: null) => unknown) =>
      action(null)
  ),
  readLegacyMutationSource: (action: () => unknown) => action()
}));
import { identityFetcher } from '@/api-serverless/src/identities/identity.fetcher';
jest.mock('@/competitions/competition-entry-drop-hooks');
import { competitionEntryDropHooks } from '@/competitions/competition-entry-drop-hooks';
import { CompetitionRecord } from '@/competitions/competition.repository';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { ConnectionWrapper } from '@/sql-executor';
import { userGroupsService } from '@/api-serverless/src/community-members/user-groups.service';
import { waveScoreService } from '@/api/waves/wave-score.service';
import { waveDropMetricsRefreshService } from '@/drops/wave-drop-metrics-refresh.service';
import { DropType } from '@/entities/IDrop';
import { DeleteDropUseCase } from './delete-drop.use-case';
import { withLegacyPrimaryMutation } from '@/competitions/legacy-competition-mutation';

afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(() => {
  jest.mocked(competitionEntryDropHooks.lockForDelete).mockResolvedValue([]);
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
      dropVotingService,
      artCurationTokenWatchService,
      attachmentsDb,
      dropPollsDb,
      wavesApiDb
    };
  }

  it.each([DropType.CHAT, DropType.PARTICIPATORY])(
    'only bypasses the competition owner for chat edit cleanup (%s)',
    async (dropType) => {
      const { useCase, dropsDb, dropVotingService } = createUseCase({
        drop: {
          id: 'drop-1',
          wave_id: 'wave-1',
          author_id: 'author-1',
          serial_no: 7,
          drop_type: dropType
        },
        wave: { description_drop_id: 'description-drop' }
      });
      const ownerLock = jest.mocked(withLegacyPrimaryMutation);
      ownerLock.mockClear();
      jest
        .spyOn(useCase as any, 'assertDeleterIsAllowedToDeleteDrop')
        .mockResolvedValue(undefined);

      await useCase.execute(
        {
          drop_id: 'drop-1',
          deleter_id: 'author-1',
          deletion_purpose: 'UPDATE'
        },
        { connection: {} as any }
      );

      expect(dropsDb.deleteDropEntity).toHaveBeenCalled();
      expect(ownerLock).toHaveBeenCalledTimes(
        dropType === DropType.CHAT ? 0 : 1
      );
      expect(dropVotingService.deleteVotes).not.toHaveBeenCalled();
      expect(dropsDb.applyDeletedDropMetricsDelta).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      raw: DropType.PARTICIPATORY,
      status: null,
      membership: null,
      expected: DropType.PARTICIPATORY
    },
    {
      raw: DropType.WINNER,
      status: null,
      membership: null,
      expected: DropType.WINNER
    },
    {
      raw: DropType.COMPETITION,
      status: null,
      membership: null,
      expected: DropType.COMPETITION
    },
    {
      raw: DropType.WINNER,
      status: CompetitionEntryStatus.ACTIVE,
      membership: 'primary',
      expected: DropType.PARTICIPATORY
    },
    {
      raw: DropType.PARTICIPATORY,
      status: CompetitionEntryStatus.WINNER,
      membership: 'primary',
      expected: DropType.WINNER
    },
    {
      raw: DropType.PARTICIPATORY,
      status: CompetitionEntryStatus.WITHDRAWN,
      membership: 'primary',
      expected: DropType.COMPETITION
    },
    {
      raw: DropType.WINNER,
      status: CompetitionEntryStatus.DISQUALIFIED,
      membership: 'primary',
      expected: DropType.COMPETITION
    },
    {
      raw: DropType.PARTICIPATORY,
      status: CompetitionEntryStatus.ACTIVE,
      membership: 'sibling',
      expected: DropType.COMPETITION
    }
  ])(
    'uses $expected deletion metrics for shared $raw and native $membership/$status',
    async ({ raw, status, membership, expected }) => {
      const connection = {} as ConnectionWrapper<unknown>;
      const { useCase, dropsDb } = createUseCase({
        drop: {
          id: 'drop-1',
          wave_id: 'wave-1',
          author_id: 'author',
          serial_no: 1,
          created_at: 1,
          drop_type: raw
        },
        wave: { description_drop_id: 'description' }
      });
      jest
        .mocked(withLegacyPrimaryMutation)
        .mockImplementationOnce(async (_wave, _ctx, action) =>
          action({ id: 'primary' } as CompetitionRecord)
        );
      if (status !== null)
        jest
          .mocked(competitionEntryDropHooks.lockForDelete)
          .mockResolvedValueOnce([
            {
              id: 'entry',
              competition_id: membership === 'primary' ? 'primary' : 'sibling',
              wave_id: 'wave-1',
              drop_id: 'drop-1',
              submitter_id: 'author',
              status,
              config_version: 1,
              submitted_at: 1,
              rank: null,
              won_at: null,
              decision_id: null,
              signed: false
            }
          ]);
      jest
        .spyOn(
          waveDropMetricsRefreshService,
          'markWaveDropMetricsDirtyBestEffort'
        )
        .mockResolvedValue(undefined);
      jest
        .spyOn(waveScoreService, 'markWaveScoresDirtyBestEffort')
        .mockResolvedValue(undefined);
      await useCase.execute(
        { drop_id: 'drop-1', deletion_purpose: 'SYSTEM_DELETE' },
        { connection }
      );
      expect(dropsDb.applyDeletedDropMetricsDelta).toHaveBeenCalledWith(
        expect.objectContaining({ drop_type: expected }),
        { timer: undefined, connection }
      );
    }
  );

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

  describe('replies in waves with open replies', () => {
    const openRepliesWave = {
      description_drop_id: 'description-drop',
      visibility_group_id: null,
      created_by: 'wave-creator',
      admin_group_id: 'admin-group',
      chat_group_id: 'dev-team',
      chat_replies_open: true,
      admin_drop_deletion_enabled: false
    };
    const replyDrop = {
      id: 'reply-1',
      wave_id: 'wave-1',
      serial_no: 8,
      created_at: 124,
      author_id: 'replier',
      drop_type: DropType.CHAT,
      reply_to_drop_id: 'announcement-1'
    };

    const deleteAs = (
      deleterId: string,
      {
        drop = replyDrop,
        wave = openRepliesWave
      }: { drop?: Record<string, unknown>; wave?: Record<string, unknown> } = {}
    ) => {
      const { useCase } = createUseCase({
        drop: drop as any,
        wave: wave as any
      });
      return useCase.execute(
        {
          drop_id: String(drop.id),
          deleter_id: deleterId,
          deletion_purpose: 'DELETE'
        },
        { connection: {} as any }
      );
    };

    it('lets people who can post delete replies', async () => {
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue(['dev-team']);

      await expect(deleteAs('poster')).resolves.toMatchObject({
        id: 'reply-1'
      });
    });

    it('lets wave admins delete replies without admin drop deletion', async () => {
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue(['admin-group']);

      await expect(deleteAs('admin')).resolves.toMatchObject({
        id: 'reply-1'
      });
    });

    it('does not let posters delete top-level drops', async () => {
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue(['dev-team']);

      await expect(
        deleteAs('poster', {
          drop: { ...replyDrop, reply_to_drop_id: null }
        })
      ).rejects.toThrow('User is not allowed to delete this drop');
    });

    it('does not let other repliers delete replies', async () => {
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue([]);

      await expect(deleteAs('other-replier')).rejects.toThrow(
        'User is not allowed to delete this drop'
      );
    });

    it('keeps reply deletion closed when replies are not open', async () => {
      jest
        .spyOn(userGroupsService, 'getGroupsUserIsEligibleFor')
        .mockResolvedValue(['dev-team']);

      await expect(
        deleteAs('poster', {
          wave: { ...openRepliesWave, chat_replies_open: false }
        })
      ).rejects.toThrow('User is not allowed to delete this drop');
    });
  });
});

describe('DeleteDropUseCase chat history batch', () => {
  it('updates dirty repair and eligible DM unread versions once for a full batch', async () => {
    const purgeDb = { deleteBatch: jest.fn().mockResolvedValue(undefined) };
    const wavesDb = {
      incrementDmUnreadStateVersionsForWaveReaders: jest
        .fn()
        .mockResolvedValue(['reader']),
      findWaveById: jest
        .fn()
        .mockResolvedValue({ visibility_group_id: 'parent-group' })
    };
    const useCase = new DeleteDropUseCase(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      wavesDb as never,
      purgeDb as never
    );
    jest
      .spyOn(userGroupsService, 'findIdentitiesInGroups')
      .mockImplementation(async (groups) =>
        groups[0] === 'chat-group'
          ? ['author', 'reader', 'ineligible']
          : ['reader']
      );
    const metrics = jest
      .spyOn(
        waveDropMetricsRefreshService,
        'markWaveDropMetricsDirtyBestEffort'
      )
      .mockResolvedValue(undefined);
    const scores = jest
      .spyOn(waveScoreService, 'markWaveScoresDirtyBestEffort')
      .mockResolvedValue(undefined);
    const scope = { waveId: 'wave', authorId: 'author', cutoffSerialNo: 60000 };
    const drops = Array.from({ length: 100 }, (_, i) => ({
      id: `drop-${i}`,
      serial_no: i + 1,
      wave_id: 'wave',
      author_id: 'author',
      drop_type: DropType.CHAT
    }));
    const wave = {
      id: 'wave',
      description_drop_id: 'pin',
      is_direct_message: true,
      chat_group_id: 'chat-group',
      visibility_group_id: 'visibility-group',
      parent_wave_id: 'parent'
    };
    const ctx = { connection: {} };
    await expect(
      useCase.executeChatHistoryBatch(
        scope,
        drops as never,
        wave as never,
        ctx as never
      )
    ).resolves.toEqual(['reader']);
    expect(purgeDb.deleteBatch).toHaveBeenCalledTimes(1);
    expect(metrics).toHaveBeenCalledTimes(1);
    expect(scores).toHaveBeenCalledTimes(1);
    expect(
      wavesDb.incrementDmUnreadStateVersionsForWaveReaders
    ).toHaveBeenCalledTimes(1);
    expect(
      wavesDb.incrementDmUnreadStateVersionsForWaveReaders
    ).toHaveBeenCalledWith({ waveId: 'wave', readerIds: ['reader'] }, ctx);
    await expect(
      useCase.executeChatHistoryBatch(scope, [], wave as never, ctx as never)
    ).resolves.toEqual([]);
    expect(purgeDb.deleteBatch).toHaveBeenCalledTimes(1);
    await expect(
      useCase.executeChatHistoryBatch(
        scope,
        [{ ...drops[0], id: 'pin' }] as never,
        wave as never,
        ctx as never
      )
    ).rejects.toThrow('Invalid chat history purge batch');
  });
});
