import { ApiDrop } from '@/api/generated/models/ApiDrop';
import {
  DROP_UPDATE_REASON_POLL_RESPONSE,
  dropUpdateMessage,
  dropUpdateRefMessage,
  identityNotificationsChangedMessage,
  notificationIdentitiesSyncedMessage,
  DELIVERY_TIMESTAMPS_RESERVED_BYTES,
  withDeliveryTimestamps,
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

  it('builds the additive stable-reference message without mutable content', () => {
    expect(
      dropUpdateRefMessage({
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_UPDATE
      })
    ).toEqual({
      type: WsMessageType.DROP_UPDATE_REF,
      data: {
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_UPDATE
      }
    });
  });

  it('preserves a source update reason without carrying content', () => {
    expect(
      dropUpdateRefMessage({
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_UPDATE,
        reason: DROP_UPDATE_REASON_POLL_RESPONSE
      })
    ).toEqual({
      type: WsMessageType.DROP_UPDATE_REF,
      data: {
        drop_id: 'drop-1',
        wave_id: 'wave-1',
        author_id: 'author-1',
        serial_no: 42,
        update_type: WsMessageType.DROP_UPDATE,
        reason: DROP_UPDATE_REASON_POLL_RESPONSE
      }
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

  describe('withDeliveryTimestamps', () => {
    it('appends server receipt and send times without re-serializing', () => {
      const message = JSON.stringify(
        dropUpdateMessage({ id: 'drop-1' } as ApiDrop, 'POLL_RESPONSE')
      );
      const stamped = withDeliveryTimestamps(message, {
        serverReceivedAt: 1_700_000_000_000.4,
        sentAt: 1_700_000_000_042
      });
      expect(stamped.startsWith(message.slice(0, -1))).toBe(true);
      expect(JSON.parse(stamped)).toEqual({
        type: WsMessageType.DROP_UPDATE,
        data: { id: 'drop-1' },
        reason: 'POLL_RESPONSE',
        server_received_at: 1_700_000_000_000,
        sent_at: 1_700_000_000_042
      });
    });

    it('omits the receipt time for background producers', () => {
      const stamped = withDeliveryTimestamps(
        '{"type":"DROP_DELETE","data":{}}',
        { serverReceivedAt: null, sentAt: 5 }
      );
      expect(JSON.parse(stamped)).toEqual({
        type: 'DROP_DELETE',
        data: {},
        sent_at: 5
      });
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY])(
      'never writes a non-finite send time (%p)',
      (sentAt) => {
        const message = '{"type":"DROP_DELETE","data":{}}';
        expect(
          withDeliveryTimestamps(message, { serverReceivedAt: 1, sentAt })
        ).toBe(message);
      }
    );

    it('fits the longest stamp inside the reserved bytes', () => {
      const stamped = withDeliveryTimestamps('{"a":1}', {
        serverReceivedAt: 9_999_999_999_999,
        sentAt: 9_999_999_999_999
      });
      expect(Buffer.byteLength(stamped) - '{"a":1}'.length).toBeLessThanOrEqual(
        DELIVERY_TIMESTAMPS_RESERVED_BYTES
      );
    });

    it.each(['{}', '[]', 'not json', ''])('leaves %p unchanged', (message) => {
      expect(
        withDeliveryTimestamps(message, { serverReceivedAt: 1, sentAt: 2 })
      ).toBe(message);
    });
  });
});
