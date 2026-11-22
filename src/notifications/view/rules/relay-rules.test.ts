import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type {
  DropReactionEvent,
  FollowChangedEvent
} from '@/notifications/view/notification-sources';
import {
  DropCreationFacts,
  DropVersionFacts,
  deriveDropCreation,
  deriveFollow,
  derivePriorityAlert,
  deriveReaction
} from './relay-rules';

const T0 = 1_795_000_000_000;

describe('relay notification rules', () => {
  describe('reactions and boosts', () => {
    const react = (
      over: Partial<DropReactionEvent> = {}
    ): DropReactionEvent => ({
      eventId: '0xevent',
      timeMs: T0,
      waveId: 'wave',
      visibilityGroupId: 'group',
      dropId: 'drop',
      dropAuthorId: 'author',
      reactorId: 'reactor',
      reaction: ':fire:',
      on: true,
      previous: null,
      ...over
    });

    it('notifies the author of a reaction turned on', () => {
      expect(deriveReaction(react())).toEqual({
        family: 'reaction',
        ref: '0xevent',
        rows: [
          expect.objectContaining({
            identity_id: 'author',
            created_at: T0,
            cause: IdentityNotificationCause.DROP_REACTED,
            additional_identity_id: 'reactor',
            related_drop_id: 'drop',
            wave_id: 'wave',
            visibility_group_id: 'group',
            additional_data: { reaction: ':fire:' }
          })
        ]
      });
    });

    it('notifies again after the reaction changed or was off', () => {
      for (const previous of [
        { reaction: ':fire:', on: false },
        { reaction: ':heart:', on: true }
      ]) {
        expect(deriveReaction(react({ previous })).rows).toHaveLength(1);
      }
    });

    it('treats the boost reaction as DROP_BOOSTED with no data', () => {
      expect(deriveReaction(react({ reaction: 'boost' })).rows[0]).toEqual(
        expect.objectContaining({
          cause: IdentityNotificationCause.DROP_BOOSTED,
          additional_data: {}
        })
      );
    });

    it.each([
      ['a reaction turned off', { on: false }],
      [
        'a repeat of the same reaction',
        { previous: { reaction: ':fire:', on: true } }
      ],
      ['the author reacting', { reactorId: 'author' }]
    ])('derives nothing for %s', (_label, over) => {
      expect(deriveReaction(react(over)).rows).toEqual([]);
    });
  });

  describe('follows', () => {
    const follow = (
      over: Partial<FollowChangedEvent> = {}
    ): FollowChangedEvent => ({
      eventId: '0xfollow',
      timeMs: T0,
      subscriberId: 'fan',
      targetId: 'artist',
      following: true,
      wasFollowing: false,
      imported: false,
      ...over
    });

    it('notifies the target when someone starts following', () => {
      expect(deriveFollow(follow()).rows).toEqual([
        expect.objectContaining({
          identity_id: 'artist',
          cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
          additional_identity_id: 'fan',
          additional_data: {}
        })
      ]);
    });

    it.each([
      ['an imported follow', { imported: true }],
      ['an unfollow', { following: false }],
      ['a follow that already held', { wasFollowing: true }]
    ])('derives nothing for %s', (_label, over) => {
      expect(deriveFollow(follow(over)).rows).toEqual([]);
    });
  });

  describe('drop creation', () => {
    const version = (
      over: Partial<DropVersionFacts> = {}
    ): DropVersionFacts => ({
      eventId: '0xroot',
      timeMs: T0,
      reply: null,
      quotes: [],
      mentionedIds: [],
      ...over
    });
    const facts = (
      over: Partial<DropCreationFacts> = {}
    ): DropCreationFacts => ({
      rootEventId: '0xroot',
      dropId: 'drop',
      waveId: 'wave',
      visibilityGroupId: 'group',
      authorId: 'author',
      deleted: false,
      versions: [version()],
      permissionGroupMentionIds: [],
      mentionsAll: false,
      followers: [],
      readers: new Set(['author', 'm1', 'm2', 'f1', 'f2', 'q1', 'r1']),
      mutedWave: new Set(),
      suppressFollowers: false,
      ...over
    });
    const causes = (group: ReturnType<typeof deriveDropCreation>) =>
      Object.fromEntries(group.rows.map((row) => [row.identity_id, row.cause]));

    it('keeps today precedence: reply over quote over mention over all drops', () => {
      const group = deriveDropCreation(
        facts({
          versions: [
            version({
              reply: { dropId: 'parent', partNo: 2, authorId: 'r1' },
              quotes: [
                {
                  quotePartNo: 1,
                  quotedDropId: 'quoted',
                  quotedPartNo: 3,
                  quotedAuthorId: 'q1'
                },
                {
                  quotePartNo: 2,
                  quotedDropId: 'other',
                  quotedPartNo: 1,
                  quotedAuthorId: 'r1'
                }
              ],
              mentionedIds: ['q1', 'm1', 'author']
            })
          ],
          followers: [
            { identityId: 'm1', allDrops: true, groupOptIn: false },
            { identityId: 'f1', allDrops: true, groupOptIn: false },
            { identityId: 'f2', allDrops: false, groupOptIn: false }
          ]
        })
      );
      expect(group).toEqual(
        expect.objectContaining({ family: 'drop', ref: '0xroot' })
      );
      expect(causes(group)).toEqual({
        r1: IdentityNotificationCause.DROP_REPLIED,
        q1: IdentityNotificationCause.DROP_QUOTED,
        m1: IdentityNotificationCause.IDENTITY_MENTIONED,
        f1: IdentityNotificationCause.ALL_DROPS
      });
      const byId = Object.fromEntries(
        group.rows.map((row) => [row.identity_id, row])
      );
      expect(byId.r1).toEqual(
        expect.objectContaining({
          additional_identity_id: 'author',
          related_drop_id: 'drop',
          related_drop_part_no: null,
          related_drop_2_id: 'parent',
          related_drop_2_part_no: 2,
          wave_id: 'wave',
          visibility_group_id: 'group',
          created_at: T0
        })
      );
      expect(byId.q1).toEqual(
        expect.objectContaining({
          related_drop_id: 'drop',
          related_drop_part_no: 1,
          related_drop_2_id: 'quoted',
          related_drop_2_part_no: 3
        })
      );
      expect(byId.m1).toEqual(
        expect.objectContaining({
          related_drop_id: 'drop',
          related_drop_2_id: null
        })
      );
    });

    it('needs read access and no wave mute for mentions, but not for a reply', () => {
      const group = deriveDropCreation(
        facts({
          versions: [
            version({
              reply: { dropId: 'parent', partNo: 1, authorId: 'outsider' },
              mentionedIds: ['m1', 'm2', 'stranger']
            })
          ],
          mutedWave: new Set(['m2'])
        })
      );
      expect(causes(group)).toEqual({
        outsider: IdentityNotificationCause.DROP_REPLIED,
        m1: IdentityNotificationCause.IDENTITY_MENTIONED
      });
    });

    it('sends @all to opted-in readers and group mentions from the root', () => {
      const group = deriveDropCreation(
        facts({
          mentionsAll: true,
          permissionGroupMentionIds: ['m2'],
          followers: [
            { identityId: 'f1', allDrops: false, groupOptIn: true },
            { identityId: 'f2', allDrops: false, groupOptIn: false },
            { identityId: 'stranger', allDrops: true, groupOptIn: true }
          ]
        })
      );
      expect(causes(group)).toEqual({
        f1: IdentityNotificationCause.IDENTITY_MENTIONED,
        m2: IdentityNotificationCause.IDENTITY_MENTIONED
      });
    });

    it('drops all-drops rows for suppressed content', () => {
      const group = deriveDropCreation(
        facts({
          suppressFollowers: true,
          followers: [{ identityId: 'f1', allDrops: true, groupOptIn: false }]
        })
      );
      expect(group.rows).toEqual([]);
    });

    it('follows the latest version, keeping each recipient first time', () => {
      const edited = facts({
        versions: [
          version({ mentionedIds: ['m1'] }),
          version({
            eventId: '0xedit',
            timeMs: T0 + 60_000,
            mentionedIds: ['m2'],
            reply: null
          }),
          version({
            eventId: '0xedit2',
            timeMs: T0 + 120_000,
            mentionedIds: ['m2', 'm1']
          })
        ]
      });
      const group = deriveDropCreation(edited);
      expect(
        group.rows.map((row) => [row.identity_id, row.created_at])
      ).toEqual([
        ['m1', T0],
        ['m2', T0 + 60_000]
      ]);
      // An edit that drops a mention drops its row.
      const removed = deriveDropCreation(
        facts({
          versions: [
            version({ mentionedIds: ['m1', 'm2'] }),
            version({ eventId: '0xedit', timeMs: T0 + 1, mentionedIds: ['m2'] })
          ]
        })
      );
      expect(removed.rows.map((row) => row.identity_id)).toEqual(['m2']);
    });

    it('has no rows for a deleted drop', () => {
      expect(
        deriveDropCreation(
          facts({
            deleted: true,
            versions: [version({ mentionedIds: ['m1'] })]
          })
        ).rows
      ).toEqual([]);
    });
  });

  it('notifies alert wave members except the author', () => {
    const group = derivePriorityAlert({
      rootEventId: '0xalert',
      dropId: 'alert-drop',
      waveId: 'alerts',
      authorId: 'ops',
      timeMs: T0,
      deleted: false,
      memberIds: ['b', 'ops', 'a', 'b']
    });
    expect(group.rows.map((row) => row.identity_id)).toEqual(['a', 'b']);
    expect(group.rows[0]).toEqual(
      expect.objectContaining({
        cause: IdentityNotificationCause.PRIORITY_ALERT,
        additional_identity_id: 'ops',
        related_drop_id: 'alert-drop',
        wave_id: 'alerts',
        visibility_group_id: null
      })
    );
  });
});
