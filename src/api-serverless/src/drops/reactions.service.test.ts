jest.mock('../api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

import { mock } from 'ts-jest-mocker';
import { ReactionsDb } from './reactions.db';
import { WavesApiDb } from '../waves/waves.api.db';
import { DropsDb } from '@/drops/drops.db';
import { UserGroupsService } from '../community-members/user-groups.service';
import { UserNotifier } from '@/notifications/user.notifier';
import { WsListenersNotifier } from '../ws/ws-listeners-notifier';
import { DropsApiService } from './drops.api.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import { ReactionsService } from './reactions.service';
import { DropEntity, DropType } from '@/entities/IDrop';
import { profileActivityLogsDb } from '@/profileActivityLogs/profile-activity-logs.db';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';

describe('ReactionsService', () => {
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
  const ctx = { connection };
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
    hide_link_preview: false
  };
  const drop = { id: dropEntity.id } as any;

  beforeEach(() => {
    reactionsDb = mock();
    wavesDb = mock();
    dropsDb = mock();
    userGroupsService = mock();
    userNotifier = mock();
    wsListenersNotifier = mock();
    dropsService = mock();
    metricsRecorder = mock();

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

    jest.spyOn(profileActivityLogsDb, 'insert').mockResolvedValue(undefined);
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
      ctx
    );
    expect(metricsRecorder.recordActiveIdentity).not.toHaveBeenCalled();
    expect(profileActivityLogsDb.insert).not.toHaveBeenCalled();
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
      ctx
    );
    expect(metricsRecorder.recordActiveIdentity).toHaveBeenCalledWith(
      { identityId: 'profile-1' },
      ctx
    );
    expect(profileActivityLogsDb.insert).toHaveBeenCalled();
    expect(userNotifier.notifyOfDropReaction).toHaveBeenCalled();
    expect(giveReadReplicaTimeToCatchUp).toHaveBeenCalled();
    expect(
      wsListenersNotifier.notifyAboutDropReactionUpdate
    ).toHaveBeenCalledWith(drop, ctx);
  });
});
