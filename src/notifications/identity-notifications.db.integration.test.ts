import 'reflect-metadata';
import { DROPS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { IdentityNotificationsDb } from './identity-notifications.db';

const GROUP_DM_VISIBILITY_ID =
  'dm-prxt0-prxt0bot-phoebeumzz-kcZmGt9vcKHMvmKJkobfH5';

const author = anIdentity(
  {},
  {
    consolidation_key: 'group-dm-notification-author',
    profile_id: 'group-dm-notification-author',
    primary_address: 'group-dm-notification-author-wallet',
    handle: 'group-dm-notification-author'
  }
);
const recipient = anIdentity(
  {},
  {
    consolidation_key: 'group-dm-notification-recipient',
    profile_id: 'group-dm-notification-recipient',
    primary_address: 'group-dm-notification-recipient-wallet',
    handle: 'group-dm-notification-recipient'
  }
);
const wave = aWave(
  {
    created_by: author.profile_id!,
    is_direct_message: true,
    visibility_group_id: GROUP_DM_VISIBILITY_ID,
    participation_group_id: GROUP_DM_VISIBILITY_ID,
    chat_group_id: GROUP_DM_VISIBILITY_ID,
    admin_group_id: GROUP_DM_VISIBILITY_ID
  },
  {
    id: 'group-dm-notification-wave',
    serial_no: 1,
    name: 'Three-person DM'
  }
);
const drop = {
  serial_no: 1,
  id: 'group-dm-notification-drop',
  wave_id: wave.id,
  author_id: author.profile_id!,
  created_at: 1,
  updated_at: null,
  title: null,
  parts_count: 1,
  reply_to_drop_id: null,
  reply_to_part_id: null,
  drop_type: DropType.CHAT,
  signature: null,
  hide_link_preview: false
};

describeWithSeed(
  'IdentityNotificationsDb long private group IDs',
  [
    withIdentities([author, recipient]),
    withWaves([wave]),
    { table: DROPS_TABLE, rows: [drop] }
  ],
  () => {
    const repo = new IdentityNotificationsDb(() => sqlExecutor);
    const originalNotifierActivated = process.env.USER_NOTIFIER_ACTIVATED;

    beforeEach(() => {
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
    });

    afterEach(() => {
      process.env.USER_NOTIFIER_ACTIVATED = originalNotifierActivated;
    });

    it('preserves a three-person DM group ID for feed visibility and push queuing', async () => {
      expect(GROUP_DM_VISIBILITY_ID).toHaveLength(51);

      const insertedIds = await repo.insertManyNotifications([
        {
          identity_id: recipient.profile_id!,
          additional_identity_id: author.profile_id!,
          related_drop_id: drop.id,
          related_drop_part_no: null,
          related_drop_2_id: null,
          related_drop_2_part_no: null,
          cause: IdentityNotificationCause.ALL_DROPS,
          additional_data: {},
          visibility_group_id: GROUP_DM_VISIBILITY_ID,
          wave_id: wave.id
        }
      ]);

      expect(insertedIds).toHaveLength(1);
      await expect(
        repo.findNotifications({
          identity_id: recipient.profile_id!,
          id_less_than: null,
          limit: 20,
          eligible_group_ids: [GROUP_DM_VISIBILITY_ID],
          cause: null,
          cause_exclude: null,
          unread_only: false
        })
      ).resolves.toEqual([
        expect.objectContaining({
          id: insertedIds[0],
          visibility_group_id: GROUP_DM_VISIBILITY_ID,
          related_drop_id: drop.id,
          cause: IdentityNotificationCause.ALL_DROPS
        })
      ]);
      await expect(
        repo.findNotifications({
          identity_id: recipient.profile_id!,
          id_less_than: null,
          limit: 20,
          eligible_group_ids: [],
          cause: null,
          cause_exclude: null,
          unread_only: false
        })
      ).resolves.toEqual([]);
    });
  }
);
