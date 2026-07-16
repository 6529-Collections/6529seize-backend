import { ApiDrop } from '@/api/generated/models/ApiDrop';
import {
  DROP_UPDATE_REASON_POLL_RESPONSE,
  dropUpdateMessage,
  identityNotificationsChangedMessage,
  notificationIdentitiesSyncedMessage,
  WsMessageType
} from './ws-message';

describe('ws-message', () => {
  it('omits reason from drop update messages by default', () => {
    const drop = { id: 'drop-1' } as ApiDrop;

    const message = dropUpdateMessage(drop);

    expect(message).toEqual({
      type: WsMessageType.DROP_UPDATE,
      data: { id: 'drop-1' }
    });
    expect(message).not.toHaveProperty('reason');
  });

  it('includes reason in drop update messages when provided', () => {
    const drop = { id: 'drop-1' } as ApiDrop;

    const message = dropUpdateMessage(drop, DROP_UPDATE_REASON_POLL_RESPONSE);

    expect(message).toEqual({
      type: WsMessageType.DROP_UPDATE,
      data: { id: 'drop-1' },
      reason: 'POLL_RESPONSE'
    });
  });

  it('builds recipient-scoped notification protocol messages', () => {
    expect(identityNotificationsChangedMessage('profile-1')).toEqual({
      type: WsMessageType.IDENTITY_NOTIFICATIONS_CHANGED,
      data: { profile_id: 'profile-1' }
    });
    expect(notificationIdentitiesSyncedMessage(['profile-1'])).toEqual({
      type: WsMessageType.NOTIFICATION_IDENTITIES_SYNCED,
      data: { profile_ids: ['profile-1'] }
    });
  });
});
