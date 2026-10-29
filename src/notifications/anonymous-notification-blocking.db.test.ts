import { IdentityMutesDb } from '@/api/identity-mutes/identity-mutes.db';
import { ContentModerationDb } from '@/content-moderation/content-moderation.db';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITIONS_TABLE,
  DROPS_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_MUTES_TABLE
} from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { WaveType } from '@/entities/IWave';
import { IdentityNotificationsDb } from '@/notifications/identity-notifications.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

const wave = aWave(
  { type: WaveType.RANK },
  { id: 'anonymous-notification-wave', name: 'Competition' }
);
const competition = nativeOriginalPrimaryFixture(wave);
const profiles = ['author', 'recipient', 'voter'];
const causes = [
  IdentityNotificationCause.IDENTITY_MENTIONED,
  IdentityNotificationCause.DROP_QUOTED,
  IdentityNotificationCause.DROP_REPLIED,
  IdentityNotificationCause.ALL_DROPS,
  IdentityNotificationCause.PRIORITY_ALERT
];
const notification = (
  cause: IdentityNotificationCause,
  related_drop_id = 'active',
  additional_identity_id = 'author'
) => ({
  identity_id: 'recipient',
  additional_identity_id,
  cause,
  related_drop_id,
  related_drop_part_no: null,
  related_drop_2_id: null,
  related_drop_2_part_no: null,
  wave_id: wave.id,
  visibility_group_id: null,
  additional_data: {}
});
const notices = [
  ...causes.map((cause) => notification(cause)),
  notification(IdentityNotificationCause.ALL_DROPS, 'winner'),
  notification(IdentityNotificationCause.DROP_REACTED),
  notification(IdentityNotificationCause.DROP_VOTED, 'active', 'voter'),
  notification(IdentityNotificationCause.IDENTITY_MENTIONED, 'active', 'voter')
];

describeWithSeed(
  'anonymous notification blocking privacy',
  [
    withWaves([wave]),
    withProfiles(
      profiles.map((id) =>
        aProfile({
          external_id: id,
          handle: id,
          primary_wallet: `wallet-${id}`
        })
      )
    ),
    withIdentities(
      profiles.map((id) =>
        anIdentity(
          {},
          {
            profile_id: id,
            handle: id,
            consolidation_key: `wallet-${id}`,
            primary_address: `wallet-${id}`
          }
        )
      )
    ),
    {
      table: COMPETITIONS_TABLE,
      rows: [
        {
          ...competition,
          participation_config: {
            ...competition.participation_config,
            anonymous_submissions: true
          }
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: ['active', 'winner'].map((id, index) => ({
        id,
        serial_no: index + 1,
        wave_id: wave.id,
        author_id: 'author',
        created_at: 1,
        drop_type: 'COMPETITION',
        parts_count: 1
      }))
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: ['active', 'winner'].map((id) => ({
        id: `entry-${id}`,
        competition_id: competition.id,
        wave_id: wave.id,
        drop_id: id,
        submitter_id: 'author',
        status: id === 'winner' ? 'WINNER' : 'ACTIVE',
        won_at: id === 'winner' ? 2 : null,
        config_version: 1,
        submitted_at: 1
      }))
    },
    {
      table: IDENTITY_NOTIFICATIONS_TABLE,
      rows: notices.map((notice, index) => ({
        ...notice,
        id: index + 1,
        created_at: 1,
        read_at: null
      }))
    }
  ],
  () => {
    const moderation = new ContentModerationDb(() => sqlExecutor);
    const mutes = new IdentityMutesDb(() => sqlExecutor);
    const notifications = new IdentityNotificationsDb(() => sqlExecutor);
    const request = {
      identity_id: 'recipient',
      id_less_than: null,
      limit: 20,
      eligible_group_ids: [],
      cause: null,
      cause_exclude: null,
      unread_only: false
    };
    const originalActivated = process.env.USER_NOTIFIER_ACTIVATED;
    beforeEach(() => {
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
    });
    afterEach(() => {
      process.env.USER_NOTIFIER_ACTIVATED = originalActivated;
    });

    it('keeps anonymous author notifications stable across block/unblock, including counts and push filtering', async () => {
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(9);
      await moderation.blockProfile('recipient', 'author', {});
      await moderation.blockProfile('recipient', 'voter', {});
      expect(
        (await notifications.findNotifications({ ...request, limit: 2 })).map(
          (row) => row.id
        )
      ).toEqual([5, 4]);
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(5);
      expect(
        (await moderation.filterBlockedNotificationRows(notices)).map(
          (row) => row.cause
        )
      ).toEqual(causes);
      await moderation.unblockProfile('recipient', 'author', {});
      await moderation.unblockProfile('recipient', 'voter', {});
      expect(await notifications.findNotifications(request)).toHaveLength(9);
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(9);
    });

    it('inserts hidden-author notices under an account block, while ordinary and voter actors remain blocked', async () => {
      await moderation.blockProfile('recipient', 'author', {});
      await moderation.blockProfile('recipient', 'voter', {});
      const inserted = await notifications.insertManyNotifications(notices);
      expect(inserted).toHaveLength(5);
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(10);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set won_at=3, status='WINNER' where drop_id='active'`
      );
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(0);
      expect(await moderation.filterBlockedNotificationRows(notices)).toEqual(
        []
      );
    });
    it('keeps historical anonymous author notices stable under identity notification mutes', async () => {
      await sqlExecutor.execute(
        `insert into ${IDENTITY_MUTES_TABLE} (muter_id, muted_identity_id, created_at) values ('recipient','author',1), ('recipient','voter',1)`
      );
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(5);
      expect(
        (await notifications.findNotifications({ ...request, limit: 2 })).map(
          (row) => row.id
        )
      ).toEqual([5, 4]);
      expect(
        (await mutes.filterMutedNotificationRows(notices)).map(
          (row) => row.cause
        )
      ).toEqual(causes);
      expect(await notifications.insertManyNotifications(notices)).toHaveLength(
        5
      );
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(10);
      await sqlExecutor.execute(
        `delete from ${IDENTITY_MUTES_TABLE} where muter_id='recipient'`
      );
      expect(
        await notifications.countUnreadNotificationsForIdentity('recipient', [])
      ).toBe(14);
    });

    it.each([true, false])(
      'defers blocked pending-entry delivery decisions until its anonymous=%s membership commits',
      async (anonymous) => {
        await moderation.blockProfile('recipient', 'author', {});
        await moderation.blockProfile('recipient', 'voter', {});
        await sqlExecutor.execute(
          `insert into ${IDENTITY_MUTES_TABLE} (muter_id, muted_identity_id, created_at) values ('recipient','author',1), ('recipient','voter',1)`
        );
        await sqlExecutor.execute(
          `update ${COMPETITIONS_TABLE} set participation_config=json_set(participation_config,'$.anonymous_submissions',:anonymous) where id=:id`,
          { anonymous, id: competition.id }
        );
        const pending = notification(
          IdentityNotificationCause.ALL_DROPS,
          'pending'
        );
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            await sqlExecutor.execute(
              `insert into ${DROPS_TABLE} (id,serial_no,wave_id,author_id,created_at,drop_type,parts_count) values ('pending',3,:waveId,'author',3,'COMPETITION',1)`,
              { waveId: wave.id },
              { wrappedConnection: connection }
            );
            const ids = await notifications.insertManyNotifications(
              [pending, { ...pending, additional_identity_id: 'voter' }],
              connection
            );
            expect(ids).toHaveLength(1);
            await sqlExecutor.execute(
              `insert into ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at) values ('entry-pending',:competitionId,:waveId,'pending','author','ACTIVE',1,3)`,
              { competitionId: competition.id, waveId: wave.id },
              { wrappedConnection: connection }
            );
          }
        );
        expect(
          await notifications.countUnreadNotificationsForIdentity(
            'recipient',
            []
          )
        ).toBe(anonymous ? 6 : 0);
        expect(
          await moderation.filterBlockedNotificationRows([pending])
        ).toHaveLength(anonymous ? 1 : 0);
        expect(await mutes.filterMutedNotificationRows([pending])).toHaveLength(
          anonymous ? 1 : 0
        );
      }
    );
  }
);
