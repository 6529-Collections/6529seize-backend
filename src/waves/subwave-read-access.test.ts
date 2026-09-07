import 'reflect-metadata';
import {
  ACTIVITY_EVENTS_TABLE,
  DROPS_TABLE,
  DROP_BOOKMARKS_TABLE
} from '@/constants';
import {
  ActivityEventAction,
  ActivityEventTargetType
} from '@/entities/IActivityEvent';
import { DropType } from '@/entities/IDrop';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb, WaveSubwavesSort } from '@/api/waves/waves.api.db';
import { DropsDb } from '@/drops/drops.db';
import { FeedDb } from '@/api/feed/feed.db';
import { DropBookmarksDb } from '@/api/drops/drop-bookmarks.db';
import { IdentitiesActivityDb } from '@/api/identities/identities.activity.db';
import { IdentityNotificationsDb } from '@/notifications/identity-notifications.db';

const author = anIdentity(
  {},
  {
    profile_id: 'access-author',
    handle: 'access-author',
    consolidation_key: 'access-author',
    primary_address: 'access-author-wallet'
  }
);
const parent = aWave(
  { created_by: author.profile_id!, visibility_group_id: 'parent-group' },
  { id: 'restricted-parent', name: 'restricted-parent', serial_no: 1 }
);
const publicChild = aWave(
  { created_by: author.profile_id!, parent_wave_id: parent.id },
  { id: 'public-child', name: 'public-child', serial_no: 2 }
);
const privateChild = aWave(
  {
    created_by: author.profile_id!,
    parent_wave_id: parent.id,
    visibility_group_id: 'child-group'
  },
  { id: 'private-child', name: 'private-child', serial_no: 3 }
);
const children = [publicChild, privateChild];
const waves = new WavesApiDb(() => sqlExecutor);
const drops = new DropsDb(() => sqlExecutor);
const feed = new FeedDb(() => sqlExecutor);
const notifications = new IdentityNotificationsDb(() => sqlExecutor);
const bookmarks = new DropBookmarksDb(() => sqlExecutor);
const activity = new IdentitiesActivityDb(() => sqlExecutor);

// Denormalized event visibility deliberately remains public: reads must check
// live wave/parent restrictions, including after either audience is changed.
describeWithSeed(
  'Independent subwave read boundaries',
  [
    withIdentities([author]),
    withWaves([parent, ...children]),
    {
      table: ACTIVITY_EVENTS_TABLE,
      rows: children.map((wave, index) => ({
        id: index + 1,
        target_id: wave.id,
        target_type: ActivityEventTargetType.WAVE,
        action: ActivityEventAction.DROP_CREATED,
        data: JSON.stringify({ wave_id: wave.id }),
        created_at: 1,
        wave_id: wave.id,
        action_author_id: author.profile_id!,
        visibility_group_id: null
      }))
    },
    {
      table: DROPS_TABLE,
      rows: children.map((wave, index) => ({
        id: `drop-${wave.id}`,
        serial_no: index + 1,
        wave_id: wave.id,
        author_id: author.profile_id!,
        created_at: 1,
        parts_count: 1,
        drop_type: DropType.CHAT,
        hide_link_preview: false
      }))
    },
    {
      table: DROP_BOOKMARKS_TABLE,
      rows: children.map((wave) => ({
        identity_id: author.profile_id!,
        drop_id: `drop-${wave.id}`,
        bookmarked_at: 1
      }))
    }
  ],
  () => {
    const originalNotifierActivated = process.env.USER_NOTIFIER_ACTIVATED;

    beforeEach(() => {
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
    });

    afterEach(() => {
      if (originalNotifierActivated === undefined) {
        delete process.env.USER_NOTIFIER_ACTIVATED;
      } else {
        process.env.USER_NOTIFIER_ACTIVATED = originalNotifierActivated;
      }
    });

    it.each([
      { groups: [], ids: [] },
      { groups: ['child-group'], ids: [] },
      { groups: ['parent-group'], ids: [publicChild.id] },
      {
        groups: ['parent-group', 'child-group'],
        ids: children.map((w) => w.id)
      }
    ])(
      'requires both audiences for lists, feeds, mentions and bookmarks: $groups',
      async ({ groups, ids }) => {
        const sort = (values: string[]) =>
          values.sort((a, b) => a.localeCompare(b));
        const expected = sort([...ids]);
        const requestedIds = children.map((w) => w.id);
        for (const child of children) {
          const drop = await drops.findDropByIdWithEligibilityCheck(
            `drop-${child.id}`,
            groups
          );
          expect(drop?.id ?? null).toBe(
            ids.includes(child.id) ? `drop-${child.id}` : null
          );
        }

        expect(
          sort(
            (await waves.findWavesByIds(requestedIds, groups)).map((w) => w.id)
          )
        ).toEqual(expected);
        expect(
          sort(
            (
              await waves.findWavesByIdsEligibleForRead(requestedIds, groups)
            ).map((w) => w.id)
          )
        ).toEqual(expected);
        expect(
          sort(
            Object.keys(
              await waves.findWaveMentionOverviewsByIds(
                requestedIds,
                groups,
                {}
              )
            )
          )
        ).toEqual(expected);
        expect(
          sort(
            (
              await waves.findSubwaves(
                {
                  parentWaveId: parent.id,
                  eligibleGroups: groups,
                  limit: 10,
                  offset: 0,
                  sort: WaveSubwavesSort.NAME
                },
                {}
              )
            ).map((w) => w.id)
          )
        ).toEqual(expected);
        expect(
          sort(
            (
              await feed.getNextActivityEvents({
                subscriber_id: author.profile_id!,
                visibility_group_ids: groups,
                limit: 10,
                serial_no_less_than: null
              })
            ).map((event) => event.wave_id!)
          )
        ).toEqual(expected);
        const marked = await bookmarks.findBookmarkedDropsForIdentity({
          identity_id: author.profile_id!,
          wave_id: null,
          page_size: 10,
          page: 1,
          sort_direction: 'ASC',
          group_ids_user_is_eligible_for: groups
        });
        expect(sort(marked.drop_ids)).toEqual(
          sort(ids.map((id) => `drop-${id}`))
        );
        expect(marked.count).toBe(ids.length);
      }
    );

    it('excludes restricted-parent content from the public feed and activity counts', async () => {
      await expect(
        feed.getNextPublicFeedActivityEvents({
          wave_ids: children.map((w) => w.id),
          limit: 10,
          serial_no_less_than: null
        })
      ).resolves.toEqual([]);
      await expect(
        activity.getPublicWaveDailyDropCounts(
          {
            profileId: author.profile_id!,
            startInclusive: 0,
            endExclusive: 100
          },
          {}
        )
      ).resolves.toEqual([]);
    });

    it('filters notification rows and unread counts using current parent access', async () => {
      const insertedIds = await notifications.insertManyNotifications(
        children.map((wave) => ({
          identity_id: author.profile_id!,
          additional_identity_id: null,
          related_drop_id: `drop-${wave.id}`,
          related_drop_part_no: null,
          related_drop_2_id: null,
          related_drop_2_part_no: null,
          cause: IdentityNotificationCause.ALL_DROPS,
          additional_data: {},
          visibility_group_id: null,
          wave_id: wave.id
        }))
      );
      expect(insertedIds).toHaveLength(children.length);
      for (const groups of [
        [],
        ['child-group'],
        ['parent-group'],
        ['parent-group', 'child-group']
      ]) {
        const expected = groups.includes('parent-group') ? groups.length : 0;
        const rows = await notifications.findNotifications({
          identity_id: author.profile_id!,
          id_less_than: null,
          limit: 10,
          eligible_group_ids: groups,
          cause: null,
          cause_exclude: null,
          unread_only: false
        });
        expect(rows).toHaveLength(expected);
        await expect(
          notifications.countUnreadNotificationsForIdentity(
            author.profile_id!,
            groups
          )
        ).resolves.toBe(expected);
      }
    });
  }
);
