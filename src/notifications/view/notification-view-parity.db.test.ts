import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import {
  IDENTITIES_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE,
  NOTIFICATION_VIEW_TABLE,
  PUSH_NOTIFICATION_OUTBOX_TABLE
} from '@/constants';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import { anIdentity } from '@/tests/fixtures/identity.fixture';
import {
  legacyCompetitionDecisionId,
  stableUuid
} from '@/competitions/competition-id';
import { identityNotificationsDb } from '@/notifications/identity-notifications.db';
import { userNotifier } from '@/notifications/user.notifier';
import type { RequestContext } from '@/request.context';
import { notificationDeriver } from './notification-deriver';
import type { DerivedGroup } from './derived-notification';
import {
  DECISION_COMPLETED_EVENT_TYPE,
  deriveDecisionResult,
  deriveEntryReleased,
  derivePollBallot,
  deriveRating,
  deriveSubmissionCreated,
  deriveVote,
  deriveWaveCreated
} from './rules/chain-rules';
import {
  deriveDropCreation,
  deriveFollow,
  derivePriorityAlert,
  deriveReaction
} from './rules/relay-rules';

// Parity with today's writers, cause by cause: the old writer writes its
// row into identity_notifications; then, from empty, the rule's row goes
// through the deriver's copy into the same table. Every column but id,
// created_at and read_at must match. Who the recipients are is the rules'
// own tests; here the inputs name the same people on both sides.

const FLAGS = [
  'NOTIFY_VIEW_MODE',
  'NOTIFY_DERIVED_CAUSES',
  'NOTIFY_LEGACY_OUTPUT',
  'USER_NOTIFIER_ACTIVATED',
  'PUSH_NOTIFICATIONS_ACTIVATED',
  'MAIN_STAGE_DECISION_IDS'
] as const;
const TABLES = [
  IDENTITY_NOTIFICATIONS_TABLE,
  NOTIFICATION_VIEW_TABLE,
  NOTIFICATION_VIEW_PUSH_OUTBOX_TABLE,
  PUSH_NOTIFICATION_OUTBOX_TABLE,
  IDENTITIES_TABLE
];
const NOW = 1_795_000_000_000;
const at = { height: 10, txIndex: 0, blockTimeMs: NOW };

const [actor, target, voter, other, fan] = Array.from({ length: 5 }, () =>
  anIdentity({})
);
const actorId = actor.profile_id!;
const targetId = target.profile_id!;
const voterId = voter.profile_id!;
const otherId = other.profile_id!;
const fanId = fan.profile_id!;

const WAVE = 'wave-1';
const GROUP = 'group-1';
const COMPETITION = '00000000-0000-4000-8000-000000000001';
const MAIN_STAGE = `0x${'ab'.repeat(32)}`;

const inTransaction = (work: (ctx: RequestContext) => Promise<unknown>) =>
  sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    work({ connection })
  );

interface Case {
  readonly cause: IdentityNotificationCause;
  readonly old: () => Promise<unknown>;
  readonly derive: () => Promise<DerivedGroup> | DerivedGroup;
}

const cases: Case[] = [
  {
    cause: IdentityNotificationCause.IDENTITY_REP,
    old: () =>
      userNotifier.notifyOfIdentityRep({
        rater_id: actorId,
        rated_id: targetId,
        amount: 7,
        rater_rating: 7,
        total: 9,
        category: 'Art'
      }),
    derive: () =>
      deriveRating({
        ...at,
        ref: '0xrep',
        origin: 'OPERATION',
        matter: 'REP',
        raterId: actorId,
        targetId,
        category: 'Art',
        oldValue: 0,
        newValue: 7,
        totalAfter: 9
      })
  },
  {
    cause: IdentityNotificationCause.IDENTITY_NIC,
    old: () =>
      userNotifier.notifyOfIdentityNic({
        rater_id: actorId,
        rated_id: targetId,
        amount: -3,
        rater_rating: -3,
        total: 10
      }),
    derive: () =>
      deriveRating({
        ...at,
        ref: '0xnic',
        origin: 'OPERATION',
        matter: 'NIC',
        raterId: actorId,
        targetId,
        category: '',
        oldValue: 0,
        newValue: -3,
        totalAfter: 10
      })
  },
  {
    cause: IdentityNotificationCause.DROP_VOTED,
    old: () =>
      userNotifier.notifyOfDropVote(
        {
          voter_id: voterId,
          drop_id: 'drop-1',
          drop_author_id: targetId,
          vote: 5,
          vote_change: 2,
          total_vote: 12,
          wave_id: WAVE
        },
        GROUP
      ),
    derive: () =>
      deriveVote({
        ...at,
        ref: '0xvote',
        origin: 'OPERATION',
        waveId: WAVE,
        visibilityGroupId: GROUP,
        entryDropId: 'drop-1',
        entryAuthorId: targetId,
        voterId,
        oldValue: 3,
        newValue: 5,
        entryTotalAfter: 12
      })
  },
  {
    cause: IdentityNotificationCause.DROP_POLL_VOTED,
    // Today the options come in option order (drop-polls.api.service.ts).
    old: () =>
      userNotifier.notifyOfDropPollVote(
        {
          voter_id: voterId,
          drop_id: 'poll-1',
          drop_author_id: targetId,
          poll_options: [
            { option_no: 1, option_string: 'One' },
            { option_no: 3, option_string: 'Three' }
          ],
          wave_id: WAVE
        },
        GROUP
      ),
    derive: () =>
      derivePollBallot({
        ...at,
        txId: '0xballot',
        waveId: WAVE,
        visibilityGroupId: GROUP,
        pollDropId: 'poll-1',
        pollAuthorId: targetId,
        voterId,
        anonymous: false,
        oldChoices: [],
        newChoices: [
          { option_no: 3, option_string: 'Three' },
          { option_no: 1, option_string: 'One' }
        ]
      })
  },
  {
    cause: IdentityNotificationCause.WAVE_CREATED,
    old: () =>
      userNotifier.notifyOfWaveCreated(
        WAVE,
        actorId,
        [targetId, otherId, actorId],
        {}
      ),
    derive: () =>
      deriveWaveCreated(
        {
          ...at,
          waveId: WAVE,
          creatorId: actorId,
          isDirectMessage: false,
          groupIds: [GROUP]
        },
        {
          followersListedInGroups: async () => [targetId, otherId, actorId],
          membersListedInGroups: async () => []
        }
      )
  },
  {
    cause: IdentityNotificationCause.COMPETITION_LIFECYCLE,
    // competition-event-dispatcher.ts passes the native event id, which
    // native-competition-runtime.repository.ts derives from the decision.
    old: () =>
      inTransaction((ctx) =>
        userNotifier.notifyOfCompetitionLifecycle(
          targetId,
          {
            event_id: stableUuid(
              COMPETITION,
              `event:decision:${legacyCompetitionDecisionId(COMPETITION, NOW - 60_000)}`
            ),
            event_type: DECISION_COMPLETED_EVENT_TYPE,
            wave_id: WAVE,
            competition_id: COMPETITION,
            competition_title: 'Main Stage'
          },
          GROUP,
          ctx
        )
      ),
    derive: () =>
      deriveDecisionResult(
        {
          ...at,
          decisionId: COMPETITION,
          occurrence: 4,
          scheduledAtMs: NOW - 60_000,
          decisionKey: null,
          waveId: WAVE,
          visibilityGroupId: GROUP,
          title: 'Main Stage',
          status: 'DECIDED',
          winnerCount: 1
        },
        { waveFollowers: async () => [targetId] }
      )
  },
  {
    cause: IdentityNotificationCause.VOTING_CREDITS_RETURNED,
    // voting-credit-returns.db.ts names the release by competition and entry.
    old: () =>
      inTransaction((ctx) =>
        userNotifier.notifyOfVotingCreditReturns(
          [
            {
              recipientId: voterId,
              data: {
                event_id: stableUuid(COMPETITION, 'credit-release:entry-1'),
                reason: 'WIN',
                wave_id: WAVE,
                competition_id: COMPETITION,
                competition_title: 'Main Stage',
                entry_id: 'entry-1',
                drop_id: 'drop-1',
                submission_title: 'Artwork',
                credit_type: 'TDH',
                amount: 20,
                released_at: NOW
              }
            }
          ],
          GROUP,
          ctx
        )
      ),
    derive: () =>
      deriveEntryReleased(
        {
          ...at,
          entryId: 'entry-1',
          decisionId: COMPETITION,
          decisionTitle: 'Main Stage',
          waveId: WAVE,
          visibilityGroupId: GROUP,
          entryDropId: 'drop-1',
          submissionTitle: 'Artwork',
          reason: 'WIN',
          creditType: 'TDH',
          creditScope: 'WAVE'
        },
        { entryVoters: async () => [{ voterId, value: -20 }] }
      )
  },
  {
    cause: IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED,
    old: () =>
      inTransaction((ctx) =>
        userNotifier.notifyOfArtistArtwork(
          targetId,
          {
            artist_id: actorId,
            drop_id: 'drop-1',
            wave_id: WAVE,
            competition_id: COMPETITION,
            entry_id: 'entry-1',
            competition_title: 'Main Stage',
            artwork_title: 'Artwork',
            submitted_at: NOW
          },
          GROUP,
          ctx
        )
      ),
    derive: () =>
      deriveSubmissionCreated(
        {
          ...at,
          entryId: 'entry-1',
          chainDecisionId: MAIN_STAGE,
          decisionId: COMPETITION,
          decisionTitle: 'Main Stage',
          waveId: WAVE,
          visibilityGroupId: GROUP,
          dropId: 'drop-1',
          artistId: actorId,
          artworkTitle: 'Artwork',
          anonymous: false
        },
        {
          artworkAlertSubscribers: async () => [targetId],
          canReadWave: async () => new Set([targetId]),
          mutedWave: async () => new Set()
        }
      )
  },
  ...[
    [IdentityNotificationCause.DROP_REACTED, ':fire:'],
    [IdentityNotificationCause.DROP_BOOSTED, 'boost']
  ].map(
    ([cause, reaction]): Case => ({
      cause: cause as IdentityNotificationCause,
      old: () =>
        reaction === 'boost'
          ? userNotifier.notifyOfDropBoost(
              {
                booster_id: voterId,
                drop_id: 'drop-1',
                drop_author_id: targetId,
                wave_id: WAVE
              },
              GROUP
            )
          : userNotifier.notifyOfDropReaction(
              {
                profile_id: voterId,
                drop_id: 'drop-1',
                drop_author_id: targetId,
                reaction,
                wave_id: WAVE
              },
              GROUP
            ),
      derive: () =>
        deriveReaction({
          eventId: '0xreact',
          timeMs: NOW,
          waveId: WAVE,
          visibilityGroupId: GROUP,
          dropId: 'drop-1',
          dropAuthorId: targetId,
          reactorId: voterId,
          reaction,
          on: true,
          previous: null
        })
    })
  ),
  {
    cause: IdentityNotificationCause.IDENTITY_SUBSCRIBED,
    old: () =>
      userNotifier.notifyOfIdentitySubscription({
        subscriber_id: otherId,
        subscribed_to: targetId
      }),
    derive: () =>
      deriveFollow({
        eventId: '0xfollow',
        timeMs: NOW,
        subscriberId: otherId,
        targetId,
        following: true,
        wasFollowing: false,
        imported: false
      })
  },
  {
    cause: IdentityNotificationCause.PRIORITY_ALERT,
    // priority-alerts.context.ts writes one row per member, as here.
    old: () =>
      inTransaction(async ({ connection }) => {
        for (const id of [targetId, otherId]) {
          await identityNotificationsDb.insertNotification(
            {
              identity_id: id,
              additional_identity_id: actorId,
              related_drop_id: 'alert-1',
              related_drop_part_no: null,
              related_drop_2_id: null,
              related_drop_2_part_no: null,
              wave_id: WAVE,
              cause: IdentityNotificationCause.PRIORITY_ALERT,
              additional_data: {},
              visibility_group_id: null
            },
            connection
          );
        }
      }),
    derive: () =>
      derivePriorityAlert({
        rootEventId: '0xalert',
        dropId: 'alert-1',
        waveId: WAVE,
        authorId: actorId,
        timeMs: NOW,
        deleted: false,
        memberIds: [targetId, otherId, actorId]
      })
  }
];

/** DROP_REPLIED, DROP_QUOTED, IDENTITY_MENTIONED and ALL_DROPS from one drop. */
const dropCase: Case & { readonly causes: IdentityNotificationCause[] } = {
  cause: IdentityNotificationCause.DROP_REPLIED,
  causes: [
    IdentityNotificationCause.DROP_REPLIED,
    IdentityNotificationCause.DROP_QUOTED,
    IdentityNotificationCause.IDENTITY_MENTIONED,
    IdentityNotificationCause.ALL_DROPS
  ],
  old: () =>
    inTransaction((ctx) =>
      userNotifier.notifyWaveDropCreatedRecipients(
        {
          waveId: WAVE,
          dropId: 'drop-new',
          relatedIdentityId: actorId,
          replyNotification: {
            reply_drop_id: 'drop-new',
            reply_drop_author_id: actorId,
            replied_drop_id: 'drop-target',
            replied_drop_part: 1,
            replied_drop_author_id: targetId,
            wave_id: WAVE
          },
          quoteNotifications: [
            {
              quote_drop_id: 'drop-new',
              quote_drop_part: 2,
              quote_drop_author_id: actorId,
              quoted_drop_id: 'drop-voter',
              quoted_drop_part: 1,
              quoted_drop_author_id: voterId,
              wave_id: WAVE
            }
          ],
          mentionedIdentityIds: [otherId, targetId],
          allDropsSubscriberIds: [fanId, otherId]
        },
        GROUP,
        ctx
      )
    ),
  derive: () =>
    deriveDropCreation({
      rootEventId: '0xdrop',
      dropId: 'drop-new',
      waveId: WAVE,
      visibilityGroupId: GROUP,
      authorId: actorId,
      deleted: false,
      versions: [
        {
          eventId: '0xdrop',
          timeMs: NOW,
          reply: { dropId: 'drop-target', partNo: 1, authorId: targetId },
          quotes: [
            {
              quotePartNo: 2,
              quotedDropId: 'drop-voter',
              quotedPartNo: 1,
              quotedAuthorId: voterId
            }
          ],
          mentionedIds: [otherId, targetId]
        }
      ],
      permissionGroupMentionIds: [],
      mentionsAll: false,
      followers: [
        { identityId: fanId, allDrops: true, groupOptIn: false },
        { identityId: otherId, allDrops: true, groupOptIn: false }
      ],
      readers: new Set([targetId, voterId, otherId, fanId]),
      mutedWave: new Set(),
      suppressFollowers: false
    })
};

const comparableRows = async () =>
  (
    await sqlExecutor.execute<Record<string, any>>(
      `select * from ${IDENTITY_NOTIFICATIONS_TABLE}`
    )
  )
    .map(
      ({
        id: _id,
        created_at: _at,
        read_at: _read,
        ...row
      }): Record<string, any> => ({
        ...row,
        additional_data:
          typeof row.additional_data === 'string'
            ? JSON.parse(row.additional_data)
            : row.additional_data
      })
    )
    .sort((a, b) =>
      `${a.identity_id}:${a.cause}`.localeCompare(`${b.identity_id}:${b.cause}`)
    );

describe('notification view parity with the old writers', () => {
  const saved = Object.fromEntries(FLAGS.map((key) => [key, process.env[key]]));
  const setFlags = (flags: Partial<Record<(typeof FLAGS)[number], string>>) => {
    for (const key of FLAGS) delete process.env[key];
    process.env.USER_NOTIFIER_ACTIVATED = 'true';
    process.env.PUSH_NOTIFICATIONS_ACTIVATED = 'true';
    process.env.MAIN_STAGE_DECISION_IDS = MAIN_STAGE;
    Object.assign(process.env, flags);
  };
  const reset = async () => {
    for (const table of TABLES) {
      await sqlExecutor.execute(`TRUNCATE TABLE ${table}`);
    }
    for (const identity of [actor, target, voter, other, fan]) {
      await sqlExecutor.bulkInsert(
        IDENTITIES_TABLE,
        [identity as unknown as Record<string, unknown>],
        Object.keys(identity)
      );
    }
  };
  afterEach(async () => {
    for (const key of FLAGS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    for (const table of TABLES) {
      await sqlExecutor.execute(`TRUNCATE TABLE ${table}`);
    }
  });

  it.each([
    ...cases.map((c) => [c.cause, { ...c, causes: [c.cause] }] as const),
    ['drop creation', dropCase] as const
  ])('%s', async (_label, c) => {
    setFlags({});
    await reset();
    await c.old();
    const legacy = await comparableRows();
    expect(legacy.length).toBeGreaterThan(0);

    await reset();
    setFlags({
      NOTIFY_VIEW_MODE: 'shadow',
      NOTIFY_DERIVED_CAUSES: c.causes.map((cause) => `${cause}@0`).join(',')
    });
    await notificationDeriver.apply(
      [await c.derive()],
      { mode: 'live', now: NOW },
      {}
    );
    expect(await comparableRows()).toEqual(legacy);
  });
});
