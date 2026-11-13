import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { RequestContext } from '@/request.context';
import { IdentityNotificationsDb } from './identity-notifications.db';
import { UserNotifier } from './user.notifier';

it('sends all collaboration notices through the standard bulk writer with the caller transaction and visibility', async () => {
  const insertManyNotifications = jest.fn().mockResolvedValue([101, 102]);
  const notifier = new UserNotifier({
    insertManyNotifications
  } as unknown as IdentityNotificationsDb);
  const ctx = { connection: {} } as RequestContext;
  const notices = ['B', 'C'].map((recipientId) => ({
    recipientId,
    data: {
      event_type: 'INVITED' as const,
      actor_id: 'A',
      drop_id: 'artwork',
      wave_id: 'wave',
      invitation_id: `invite-${recipientId}`,
      artwork_name: 'Title'
    }
  }));
  expect(
    await notifier.notifyOfMemeCollaborations(notices, 'private-group', ctx)
  ).toEqual([101, 102]);
  expect(insertManyNotifications).toHaveBeenCalledTimes(1);
  expect(insertManyNotifications).toHaveBeenCalledWith(
    notices.map(({ recipientId, data }) => ({
      identity_id: recipientId,
      additional_identity_id: 'A',
      related_drop_id: 'artwork',
      related_drop_part_no: 1,
      related_drop_2_id: null,
      related_drop_2_part_no: null,
      cause: IdentityNotificationCause.MEME_COLLABORATION,
      additional_data: data,
      wave_id: 'wave',
      visibility_group_id: 'private-group'
    })),
    ctx.connection
  );
});
