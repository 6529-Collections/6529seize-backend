import 'reflect-metadata';
import { IDENTITY_NOTIFICATIONS_TABLE } from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { IdentityNotificationsDb } from './identity-notifications.db';
import { UserNotificationMapper } from './user-notification.mapper';
import { UserNotificationsReader } from './user-notifications.reader';

const viewer = anIdentity(
  {},
  {
    consolidation_key: 'notification-compatibility',
    profile_id: 'notification-compatibility',
    primary_address: 'notification-compatibility',
    handle: 'notification-compatibility'
  }
);
const causes = [
  IdentityNotificationCause.IDENTITY_SUBSCRIBED,
  IdentityNotificationCause.WAVE_CREATED,
  IdentityNotificationCause.COMPETITION_LIFECYCLE,
  IdentityNotificationCause.COMPETITION_LIFECYCLE,
  IdentityNotificationCause.COMPETITION_LIFECYCLE,
  IdentityNotificationCause.COMPETITION_LIFECYCLE
];
const competitionEventTypes = [
  'COMPETITION_DECISION_COMPLETED',
  'COMPETITION_DECISION_COMPLETED',
  'COMPETITION_PUBLISHED',
  'COMPETITION_PAUSED'
];
const request = {
  identity_id: viewer.profile_id!,
  eligible_group_ids: [],
  id_less_than: null,
  limit: 10,
  cause: null,
  cause_exclude: null,
  unread_only: false
};

describeWithSeed(
  'notification competition opt-in compatibility',
  [
    withIdentities([viewer]),
    {
      table: IDENTITY_NOTIFICATIONS_TABLE,
      rows: causes.map((cause, index) => ({
        id: index + 1,
        identity_id: viewer.profile_id,
        additional_identity_id: viewer.profile_id,
        cause,
        created_at: index + 1,
        read_at: index === 3 ? 10 : null,
        additional_data: {
          event_id: 'event',
          event_type: competitionEventTypes[index - 2],
          competition_id: 'competition',
          competition_title: 'Contest'
        }
      }))
    }
  ],
  () => {
    const db = new IdentityNotificationsDb(() => sqlExecutor);
    const reader = new UserNotificationsReader(
      db,
      new UserNotificationMapper()
    );

    it.each([undefined, false])(
      'excludes native rows before pagination and counting by default (%s)',
      async (include_competitions) => {
        const response = await reader.getNotificationsForIdentity({
          ...request,
          include_competitions,
          limit: 1
        });
        expect(
          response.notifications.map((notification) => notification.id)
        ).toEqual([2]);
        expect(response.total_unread).toBe(2);
        const next = await reader.getNotificationsForIdentity({
          ...request,
          include_competitions,
          limit: 1,
          id_less_than: 2
        });
        expect(
          next.notifications.map((notification) => notification.id)
        ).toEqual([1]);
        expect(next.total_unread).toBe(2);
      }
    );

    it('includes native rows and unread count only with explicit opt-in', async () => {
      const response = await reader.getNotificationsForIdentity({
        ...request,
        include_competitions: true
      });
      expect(
        response.notifications.map((notification) => notification.id)
      ).toEqual([4, 3, 2, 1]);
      expect(response.total_unread).toBe(3);
      const unread = await reader.getNotificationsForIdentity({
        ...request,
        include_competitions: true,
        unread_only: true
      });
      expect(
        unread.notifications.map((notification) => notification.id)
      ).toEqual([3, 2, 1]);
      expect(unread.total_unread).toBe(3);
    });

    it('hides status-change notices before pagination and unread counting even with opt-in', async () => {
      const response = await reader.getNotificationsForIdentity({
        ...request,
        include_competitions: true,
        cause: IdentityNotificationCause.COMPETITION_LIFECYCLE,
        limit: 1
      });
      expect(
        response.notifications.map((notification) => notification.id)
      ).toEqual([4]);
      expect(response.total_unread).toBe(3);
    });

    it.each([false, true])(
      'retains page-only cause filters without narrowing total unread (%s)',
      async (include_competitions) => {
        const response = await reader.getNotificationsForIdentity({
          ...request,
          include_competitions,
          cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
          cause_exclude: IdentityNotificationCause.WAVE_CREATED
        });
        expect(
          response.notifications.map((notification) => notification.id)
        ).toEqual([1]);
        expect(response.total_unread).toBe(include_competitions ? 3 : 2);
        const excluded = await reader.getNotificationsForIdentity({
          ...request,
          include_competitions,
          cause_exclude: IdentityNotificationCause.COMPETITION_LIFECYCLE
        });
        expect(
          excluded.notifications.map((notification) => notification.id)
        ).toEqual([2, 1]);
        expect(excluded.total_unread).toBe(include_competitions ? 3 : 2);
      }
    );

    it('does not treat a cause filter as native opt-in', async () => {
      const response = await reader.getNotificationsForIdentity({
        ...request,
        cause: IdentityNotificationCause.COMPETITION_LIFECYCLE
      });
      expect(response.notifications).toEqual([]);
      expect(response.total_unread).toBe(2);
    });

    it('combines DB enabled and excluded causes independently', async () => {
      expect(
        await db.countUnreadNotificationsForIdentity(
          viewer.profile_id!,
          [],
          undefined,
          {
            enabledCauses: [
              IdentityNotificationCause.WAVE_CREATED,
              IdentityNotificationCause.COMPETITION_LIFECYCLE
            ],
            excludedCauses: [IdentityNotificationCause.COMPETITION_LIFECYCLE]
          }
        )
      ).toBe(1);
    });
  }
);
