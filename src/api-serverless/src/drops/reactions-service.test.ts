jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

import { mock } from 'ts-jest-mocker';
import { ReactionsDb } from '@/api/drops/reactions.db';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { DropsDb } from '@/drops/drops.db';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { UserNotifier } from '@/notifications/user.notifier';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import { DropsApiService } from '@/api/drops/drops.api.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import { ReactionsService } from '@/api/drops/reactions.service';
import { DropEntity, DropType } from '@/entities/IDrop';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';
import { Logger } from '@/logging';
import { BadRequestException, ForbiddenException } from '@/exceptions';

describe('ReactionsService', () => {
  const latestActivityAt = new Date('2026-06-29T00:00:00.000Z');
  let reactionsDb: ReactionsDb;
  let wavesDb: WavesApiDb;
  let dropsDb: DropsDb;
  let userGroupsService: UserGroupsService;
  let userNotifier: UserNotifier;
  let wsListenersNotifier: WsListenersNotifier;
  let dropsService: DropsApiService;
  let metricsRecorder: MetricsRecorder;
  let service: ReactionsService;

  const connection = {} as any;
  const transactionCtx = { connection };
  const ctx = {};
  const dropEntity: DropEntity = {
    serial_no: 1,
    id: 'drop-1',
    wave_id: 'wave-1',
    author_id: 'author-1',
    created_at: 100,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: DropType.CHAT,
    signature: null,
    is_additional_action_promised: null,
    hide_link_preview: false
  };
  const drop = { id: dropEntity.id } as any;

  beforeEach(() => {
    jest.clearAllMocks();

    reactionsDb = mock();
    wavesDb = mock();
    dropsDb = mock();
    userGroupsService = mock();
    userNotifier = mock();
    wsListenersNotifier = mock();
    dropsService = mock();
    metricsRecorder = mock();

    jest.spyOn(Logger.get('ReactionsService'), 'error').mockImplementation();

    service = new ReactionsService(
      reactionsDb,
      wavesDb,
      dropsDb,
      userGroupsService,
      userNotifier,
      wsListenersNotifier,
      dropsService,
      metricsRecorder
    );

    (
      userGroupsService.getGroupsUserIsEligibleFor as jest.Mock
    ).mockResolvedValue([]);
    (dropsDb.findDropByIdWithEligibilityCheck as jest.Mock).mockResolvedValue(
      dropEntity
    );
    (wavesDb.findById as jest.Mock).mockResolvedValue({
      id: dropEntity.wave_id,
      chat_enabled: true,
      visibility_group_id: 'group-1'
    });
    (dropsService.findDropByIdOrThrow as jest.Mock).mockResolvedValue(drop);
    (metricsRecorder.recordActiveIdentity as jest.Mock).mockResolvedValue(
      undefined
    );
    (userNotifier.notifyOfDropReaction as jest.Mock).mockResolvedValue(
      undefined
    );
    (
      wsListenersNotifier.notifyAboutDropReactionUpdate as jest.Mock
    ).mockResolvedValue(undefined);
    (
      reactionsDb.executeNativeQueriesInTransaction as jest.Mock
    ).mockImplementation(async (callback) => await callback(connection));

    jest
      .spyOn(profileActivityLogsDb, 'insertLogEntry')
      .mockResolvedValue(latestActivityAt);
    jest
      .spyOn(profileActivityLogsDb, 'touchLatestActivity')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats an identical reaction retry as a no-op', async () => {
    (reactionsDb.addReaction as jest.Mock).mockResolvedValue(false);

    const result = await service.addReaction(
      dropEntity.id,
      'profile-1',
      ':+1:',
      ctx as any
    );

    expect(result).toBe(drop);
    expect(reactionsDb.addReaction).toHaveBeenCalledWith(
      'profile-1',
      dropEntity.id,
      dropEntity.wave_id,
      ':+1:',
      transactionCtx
    );
    expect(metricsRecorder.recordActiveIdentity).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.insertLogEntry).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.touchLatestActivity).not.toHaveBeenCalled();
    expect(userNotifier.notifyOfDropReaction).not.toHaveBeenCalled();
    expect(giveReadReplicaTimeToCatchUp).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).not.toHaveBeenCalled();
  });

  it('records side effects when the reaction value changes', async () => {
    (reactionsDb.addReaction as jest.Mock).mockResolvedValue(true);

    await service.addReaction(dropEntity.id, 'profile-1', ':+1:', ctx as any);

    expect(reactionsDb.addReaction).toHaveBeenCalledWith(
      'profile-1',
      dropEntity.id,
      dropEntity.wave_id,
      ':+1:',
      transactionCtx
    );
    expect(metricsRecorder.recordActiveIdentity).toHaveBeenCalledWith(
      { identityId: 'profile-1' },
      ctx
    );
    expect(profileActivityLogsDb.insertLogEntry).toHaveBeenCalledWith(
      {
        profile_id: 'profile-1',
        type: ProfileActivityLogType.DROP_REACTED,
        target_id: dropEntity.id,
        contents: JSON.stringify({ reaction: ':+1:' }),
        additional_data_1: dropEntity.author_id,
        additional_data_2: dropEntity.wave_id,
        proxy_id: null
      },
      connection,
      undefined
    );
    expect(profileActivityLogsDb.touchLatestActivity).toHaveBeenCalledWith(
      'profile-1',
      latestActivityAt,
      undefined,
      undefined
    );
    expect(userNotifier.notifyOfDropReaction).toHaveBeenCalledWith(
      {
        profile_id: 'profile-1',
        drop_id: dropEntity.id,
        drop_author_id: dropEntity.author_id,
        reaction: ':+1:',
        wave_id: dropEntity.wave_id
      },
      'group-1'
    );
    expect(giveReadReplicaTimeToCatchUp).toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).toHaveBeenCalledWith(drop, ctx);
  });

  it('surfaces bad request validation failures from inside the transaction', async () => {
    const callOrder: string[] = [];
    (
      reactionsDb.executeNativeQueriesInTransaction as jest.Mock
    ).mockImplementation(async (callback) => {
      callOrder.push('transaction:start');
      try {
        return await callback(connection);
      } finally {
        callOrder.push('transaction:end');
      }
    });
    (wavesDb.findById as jest.Mock).mockImplementation(async () => {
      callOrder.push('validate');
      return null;
    });
    (dropsDb.findDropByIdWithEligibilityCheck as jest.Mock).mockImplementation(
      async () => {
        callOrder.push('eligibility');
        return dropEntity;
      }
    );

    await expect(
      service.addReaction(dropEntity.id, 'profile-1', ':+1:', ctx as any)
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(callOrder).toEqual([
      'transaction:start',
      'eligibility',
      'validate',
      'transaction:end'
    ]);
    expect(reactionsDb.executeNativeQueriesInTransaction).toHaveBeenCalled();
    expect(reactionsDb.addReaction).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.insertLogEntry).not.toHaveBeenCalled();
    expect(metricsRecorder.recordActiveIdentity).not.toHaveBeenCalled();
  });

  it('treats a duplicate remove request as a no-op', async () => {
    (reactionsDb.removeReaction as jest.Mock).mockResolvedValue(false);

    const result = await service.removeReaction(
      dropEntity.id,
      'profile-1',
      ctx as any
    );

    expect(result).toBe(drop);
    expect(reactionsDb.removeReaction).toHaveBeenCalledWith(
      'profile-1',
      dropEntity.id,
      dropEntity.wave_id,
      transactionCtx
    );
    expect(profileActivityLogsDb.insertLogEntry).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.touchLatestActivity).not.toHaveBeenCalled();
    expect(giveReadReplicaTimeToCatchUp).not.toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).not.toHaveBeenCalled();
  });

  it('records side effects when a reaction is removed', async () => {
    (reactionsDb.removeReaction as jest.Mock).mockResolvedValue(true);

    await service.removeReaction(dropEntity.id, 'profile-1', ctx as any);

    expect(reactionsDb.removeReaction).toHaveBeenCalledWith(
      'profile-1',
      dropEntity.id,
      dropEntity.wave_id,
      transactionCtx
    );
    expect(profileActivityLogsDb.insertLogEntry).toHaveBeenCalledWith(
      {
        profile_id: 'profile-1',
        type: ProfileActivityLogType.DROP_REACTED,
        target_id: dropEntity.id,
        contents: JSON.stringify({ reaction: null }),
        additional_data_1: dropEntity.author_id,
        additional_data_2: dropEntity.wave_id,
        proxy_id: null
      },
      connection,
      undefined
    );
    expect(profileActivityLogsDb.touchLatestActivity).toHaveBeenCalledWith(
      'profile-1',
      latestActivityAt,
      undefined,
      undefined
    );
    expect(giveReadReplicaTimeToCatchUp).toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).toHaveBeenCalledWith(drop, ctx);
  });

  it('surfaces forbidden validation failures from inside the transaction', async () => {
    const callOrder: string[] = [];
    (
      reactionsDb.executeNativeQueriesInTransaction as jest.Mock
    ).mockImplementation(async (callback) => {
      callOrder.push('transaction:start');
      try {
        return await callback(connection);
      } finally {
        callOrder.push('transaction:end');
      }
    });
    (wavesDb.findById as jest.Mock).mockImplementation(async () => {
      callOrder.push('validate');
      return {
        id: dropEntity.wave_id,
        chat_enabled: false,
        visibility_group_id: 'group-1'
      };
    });
    (dropsDb.findDropByIdWithEligibilityCheck as jest.Mock).mockImplementation(
      async () => {
        callOrder.push('eligibility');
        return dropEntity;
      }
    );

    await expect(
      service.removeReaction(dropEntity.id, 'profile-1', ctx as any)
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(callOrder).toEqual([
      'transaction:start',
      'eligibility',
      'validate',
      'transaction:end'
    ]);
    expect(reactionsDb.executeNativeQueriesInTransaction).toHaveBeenCalled();
    expect(reactionsDb.removeReaction).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.insertLogEntry).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.touchLatestActivity).not.toHaveBeenCalled();
  });

  it('does not fail a committed add reaction when a post-commit side effect fails', async () => {
    (reactionsDb.addReaction as jest.Mock).mockResolvedValue(true);
    (profileActivityLogsDb.touchLatestActivity as jest.Mock).mockRejectedValue(
      new Error('latest activity unavailable')
    );

    const result = await service.addReaction(
      dropEntity.id,
      'profile-1',
      ':+1:',
      ctx as any
    );

    expect(result).toBe(drop);
    expect(profileActivityLogsDb.insertLogEntry).toHaveBeenCalled();
    expect(profileActivityLogsDb.touchLatestActivity).toHaveBeenCalled();
    expect(userNotifier.notifyOfDropReaction).toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).toHaveBeenCalledWith(drop, ctx);
  });

  it('does not fail a committed add reaction when active identity metrics fail', async () => {
    (reactionsDb.addReaction as jest.Mock).mockResolvedValue(true);
    (metricsRecorder.recordActiveIdentity as jest.Mock).mockRejectedValue(
      new Error('metrics unavailable')
    );

    const result = await service.addReaction(
      dropEntity.id,
      'profile-1',
      ':+1:',
      ctx as any
    );

    expect(result).toBe(drop);
    expect(metricsRecorder.recordActiveIdentity).toHaveBeenCalled();
    expect(profileActivityLogsDb.touchLatestActivity).toHaveBeenCalled();
    expect(userNotifier.notifyOfDropReaction).toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).toHaveBeenCalledWith(drop, ctx);
  });

  it('does not fail a committed add reaction when notification enqueue fails', async () => {
    (reactionsDb.addReaction as jest.Mock).mockResolvedValue(true);
    (userNotifier.notifyOfDropReaction as jest.Mock).mockRejectedValue(
      new Error('notification unavailable')
    );

    const result = await service.addReaction(
      dropEntity.id,
      'profile-1',
      ':+1:',
      ctx as any
    );

    expect(result).toBe(drop);
    expect(metricsRecorder.recordActiveIdentity).toHaveBeenCalled();
    expect(profileActivityLogsDb.touchLatestActivity).toHaveBeenCalled();
    expect(userNotifier.notifyOfDropReaction).toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).toHaveBeenCalledWith(drop, ctx);
  });
});
