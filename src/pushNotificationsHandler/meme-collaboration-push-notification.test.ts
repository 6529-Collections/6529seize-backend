import { isNotificationEnabledForDevice } from './identity-push-notification-settings';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { DEFAULT_PUSH_NOTIFICATION_SETTINGS } from '@/entities/IPushNotificationSettings';
import { buildMemeCollaborationPushNotification } from './meme-collaboration-push-notification';

it.each([
  ['INVITED', 'invited you to collaborate on'],
  ['ACCEPTED', 'accepted your collaboration invitation for'],
  ['CANCELLED', 'cancelled your collaboration invitation for']
] as const)(
  'formats %s pushes with actor, artwork and serial-number routing',
  (event_type, action) => {
    const result = buildMemeCollaborationPushNotification(
      {
        event_type,
        artwork_name: 'Test Cat',
        actor_id: 'A',
        drop_id: 'uuid',
        wave_id: 'wave',
        invitation_id: 'invite'
      },
      123,
      { handle: 'phoebeum', pfp: 'avatar' }
    );
    expect(result.body).toBe(`phoebeum ${action} Test Cat.`);
    expect(result.data).toEqual({
      redirect: 'waves',
      wave_id: 'wave',
      drop_id: 123
    });
    expect(result.imageUrl).toBe('avatar');
  }
);
it('preserves historical and deleted-actor fallbacks', () => {
  expect(
    buildMemeCollaborationPushNotification(
      {
        event_type: 'CANCELLED',
        actor_id: 'deleted',
        drop_id: 'drop',
        wave_id: 'wave',
        invitation_id: 'invite'
      },
      null,
      null
    ).body
  ).toBe('An artist cancelled your collaboration invitation for an artwork.');
});

it('uses the existing mention push preference for all collaboration events', () => {
  expect(
    isNotificationEnabledForDevice(
      IdentityNotificationCause.MEME_COLLABORATION,
      { ...DEFAULT_PUSH_NOTIFICATION_SETTINGS, identity_mentioned: true }
    )
  ).toBe(true);
  expect(
    isNotificationEnabledForDevice(
      IdentityNotificationCause.MEME_COLLABORATION,
      { ...DEFAULT_PUSH_NOTIFICATION_SETTINGS, identity_mentioned: false }
    )
  ).toBe(false);
});
