import { ApiProfileMin } from '@/api/generated/models/ApiProfileMin';
import { anonymousNotificationProfiles } from '@/api/notifications/notifications-competition-anonymity';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { UserNotification } from '@/notifications/user-notification.types';

describe('durable anonymous notification actors', () => {
  it.each([
    {
      cause: IdentityNotificationCause.IDENTITY_MENTIONED,
      data: { mentioner_identity_id: 'author', drop_id: 'deleted' }
    },
    {
      cause: IdentityNotificationCause.DROP_QUOTED,
      data: { quote_drop_author_id: 'author', quote_drop_id: 'deleted' }
    },
    {
      cause: IdentityNotificationCause.DROP_REPLIED,
      data: { reply_drop_author_id: 'author', reply_drop_id: 'deleted' }
    }
  ])(
    'hides a deleted $cause author without any hydrated drop',
    ({ cause, data }) => {
      const profiles = {
        author: { id: 'author', handle: 'private-author' } as ApiProfileMin
      };
      const notification = {
        id: 1,
        created_at: 1,
        read_at: null,
        cause,
        data
      } as UserNotification;
      const result = anonymousNotificationProfiles(
        notification,
        profiles,
        new Set(['deleted'])
      );
      expect(result.author).toMatchObject({
        is_anonymous: true,
        handle: 'Anonymous'
      });
      expect(JSON.stringify(result)).not.toContain('private-author');
      expect(result.author.id).not.toBe('author');
      expect(profiles.author.handle).toBe('private-author');
    }
  );
});
