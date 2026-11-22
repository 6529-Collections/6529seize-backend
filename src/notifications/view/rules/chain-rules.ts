import {
  legacyCompetitionDecisionId,
  stableUuid
} from '@/competitions/competition-id';
import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type {
  DerivedGroup,
  DerivedNotification
} from '@/notifications/view/derived-notification';
import type {
  DecisionResultEvent,
  EntryReleasedEvent,
  PollBallotEvent,
  RatingChangedEvent,
  SubmissionCreatedEvent,
  VoteChangedEvent,
  WaveCreatedEvent
} from '@/notifications/view/notification-sources';
import type { NotificationLookups } from '@/notifications/view/rules/notification-lookups';

/** Today's lifecycle notice names this event type; the reader shows only it. */
export const DECISION_COMPLETED_EVENT_TYPE = 'COMPETITION_DECISION_COMPLETED';

/**
 * The event id today's decision notice carries: the native competition
 * event of the decision (native-competition-runtime.repository.ts), whose
 * decision id comes from the competition and the decision's scheduled time.
 */
export function decisionCompletedEventId(
  competitionId: string,
  scheduledAtMs: number
): string {
  const decisionId = legacyCompetitionDecisionId(competitionId, scheduledAtMs);
  return stableUuid(competitionId, `event:decision:${decisionId}`);
}

/** The release id today's credit-return notice carries (voting-credit-returns.db.ts). */
export function creditReleaseId(
  competitionId: string,
  entryId: string
): string {
  return stableUuid(competitionId, `credit-release:${entryId}`);
}

type RowFields = Omit<DerivedNotification, 'identity_id' | 'created_at'>;

function row(
  recipientId: string,
  createdAt: number,
  fields: Partial<RowFields> & Pick<RowFields, 'cause'>
): DerivedNotification {
  return {
    identity_id: recipientId,
    created_at: createdAt,
    additional_identity_id: null,
    related_drop_id: null,
    related_drop_part_no: null,
    related_drop_2_id: null,
    related_drop_2_part_no: null,
    wave_id: null,
    visibility_group_id: null,
    additional_data: {},
    ...fields
  };
}

/**
 * IDENTITY_REP and IDENTITY_NIC (`rates/ratings.service.ts`): an operation
 * that changes a rating notifies the rated profile, never the rater itself.
 * Imported ratings and the rating scan's cuts notify nobody, as today's
 * over-rate reductions don't.
 */
export function deriveRating(event: RatingChangedEvent): DerivedGroup {
  const ref = `${event.txId}:${event.matter}`;
  const amount = event.newValue - event.oldValue;
  if (
    event.origin !== 'OPERATION' ||
    amount === 0 ||
    event.raterId === event.targetId
  ) {
    return { family: 'rating', ref, rows: [] };
  }
  const additional_data =
    event.matter === 'REP'
      ? {
          amount,
          rater_rating: event.newValue,
          total: event.totalAfter,
          category: event.category
        }
      : { amount, rater_rating: event.newValue, total: event.totalAfter };
  return {
    family: 'rating',
    ref,
    rows: [
      row(event.targetId, event.blockTimeMs, {
        cause:
          event.matter === 'REP'
            ? IdentityNotificationCause.IDENTITY_REP
            : IdentityNotificationCause.IDENTITY_NIC,
        additional_identity_id: event.raterId,
        additional_data
      })
    ]
  };
}

/**
 * DROP_VOTED (`competition-voting.service.ts`, and the over-vote cuts of
 * `participation-drops-over-vote-revocation.ts`): a changed vote notifies
 * the entry's author unless the author voted. Imported votes don't notify.
 */
export function deriveVote(event: VoteChangedEvent): DerivedGroup {
  const ref = `${event.ref}:${event.voterId}:${event.entryDropId}`;
  if (
    event.origin === 'IMPORT' ||
    event.newValue === event.oldValue ||
    event.voterId === event.entryAuthorId
  ) {
    return { family: 'vote', ref, rows: [] };
  }
  return {
    family: 'vote',
    ref,
    rows: [
      row(event.entryAuthorId, event.blockTimeMs, {
        cause: IdentityNotificationCause.DROP_VOTED,
        additional_identity_id: event.voterId,
        related_drop_id: event.entryDropId,
        wave_id: event.waveId,
        visibility_group_id: event.visibilityGroupId,
        additional_data: {
          vote: event.newValue,
          vote_change: event.newValue - event.oldValue,
          total_vote: event.entryTotalAfter
        }
      })
    ]
  };
}

const sameChoices = (
  a: PollBallotEvent['oldChoices'],
  b: PollBallotEvent['newChoices']
) =>
  a.length === b.length &&
  [...a]
    .map((choice) => choice.option_no)
    .sort((x, y) => x - y)
    .join(',') ===
    [...b]
      .map((choice) => choice.option_no)
      .sort((x, y) => x - y)
      .join(',');

/**
 * DROP_POLL_VOTED (`drop-polls.api.service.ts`): changed choices notify the
 * poll's author, except in anonymous polls and for the author's own ballot.
 */
export function derivePollBallot(event: PollBallotEvent): DerivedGroup {
  const ref = event.txId;
  if (
    event.anonymous ||
    event.voterId === event.pollAuthorId ||
    sameChoices(event.oldChoices, event.newChoices)
  ) {
    return { family: 'poll', ref, rows: [] };
  }
  return {
    family: 'poll',
    ref,
    rows: [
      row(event.pollAuthorId, event.blockTimeMs, {
        cause: IdentityNotificationCause.DROP_POLL_VOTED,
        additional_identity_id: event.voterId,
        related_drop_id: event.pollDropId,
        wave_id: event.waveId,
        visibility_group_id: event.visibilityGroupId,
        additional_data: {
          // In option order, as drop-polls.api.service.ts lists them.
          poll_options: [...event.newChoices]
            .sort((a, b) => a.option_no - b.option_no)
            .map((choice) => ({
              option_no: choice.option_no,
              option_string: choice.option_string
            }))
        }
      })
    ]
  };
}

const distinctSorted = (ids: readonly string[]) =>
  Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));

/**
 * WAVE_CREATED (`wave.api.service.ts`): a DM wave notifies everyone listed
 * in its groups; any other wave notifies the creator's followers listed by
 * name in one of its groups (today's query reads include lists only, so a
 * wave without groups notifies nobody). Never the creator.
 */
export async function deriveWaveCreated(
  event: WaveCreatedEvent,
  lookups: Pick<
    NotificationLookups,
    'followersListedInGroups' | 'membersListedInGroups'
  >
): Promise<DerivedGroup> {
  const recipients = event.groupIds.length
    ? event.isDirectMessage
      ? await lookups.membersListedInGroups(event.groupIds, event.height)
      : await lookups.followersListedInGroups(
          event.creatorId,
          event.groupIds,
          event.height
        )
    : [];
  return {
    family: 'wave-created',
    ref: event.waveId,
    rows: distinctSorted(recipients)
      .filter((id) => id !== event.creatorId)
      .map((id) =>
        row(id, event.blockTimeMs, {
          cause: IdentityNotificationCause.WAVE_CREATED,
          additional_identity_id: event.creatorId,
          wave_id: event.waveId
        })
      )
  };
}

/**
 * COMPETITION_LIFECYCLE (`competition-event-dispatcher.ts`): a decided
 * result with a winner notifies the wave's followers.
 */
export async function deriveDecisionResult(
  event: DecisionResultEvent,
  lookups: Pick<NotificationLookups, 'waveFollowers'>
): Promise<DerivedGroup> {
  const ref = `${event.decisionId}:${event.occurrence}`;
  if (event.status !== 'DECIDED' || event.winnerCount < 1) {
    return { family: 'decision-result', ref, rows: [] };
  }
  const followers = await lookups.waveFollowers(event.waveId, event.height);
  return {
    family: 'decision-result',
    ref,
    rows: distinctSorted(followers).map((id) =>
      row(id, event.blockTimeMs, {
        cause: IdentityNotificationCause.COMPETITION_LIFECYCLE,
        wave_id: event.waveId,
        visibility_group_id: event.visibilityGroupId,
        additional_data: {
          event_id: decisionCompletedEventId(
            event.decisionId,
            event.scheduledAtMs
          ),
          event_type: DECISION_COMPLETED_EVENT_TYPE,
          wave_id: event.waveId,
          competition_id: event.decisionId,
          competition_title: event.title
        }
      })
    )
  };
}

/**
 * VOTING_CREDITS_RETURNED (`voting-credit-return-notifications.service.ts`):
 * when an entry wins or its submitter withdraws it, every voter with a
 * non-zero vote on it gets its credit back. Only wave-scoped credit returns.
 */
export async function deriveEntryReleased(
  event: EntryReleasedEvent,
  lookups: Pick<NotificationLookups, 'entryVoters'>
): Promise<DerivedGroup> {
  const ref = event.entryId;
  if (event.creditScope !== 'WAVE') {
    return { family: 'credit-return', ref, rows: [] };
  }
  const voters = await lookups.entryVoters(event.entryId, event.height);
  const byVoter = new Map<string, number>();
  for (const { voterId, value } of voters) {
    if (value !== 0) byVoter.set(voterId, Math.abs(value));
  }
  return {
    family: 'credit-return',
    ref,
    rows: Array.from(byVoter.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([voterId, amount]) =>
        row(voterId, event.blockTimeMs, {
          cause: IdentityNotificationCause.VOTING_CREDITS_RETURNED,
          wave_id: event.waveId,
          visibility_group_id: event.visibilityGroupId,
          additional_data: {
            event_id: creditReleaseId(event.decisionId, event.entryId),
            reason: event.reason,
            wave_id: event.waveId,
            competition_id: event.decisionId,
            competition_title: event.decisionTitle,
            entry_id: event.entryId,
            drop_id: event.entryDropId,
            submission_title: event.submissionTitle,
            credit_type: event.creditType,
            amount,
            released_at: event.blockTimeMs
          }
        })
      )
  };
}

/** MAIN_STAGE_DECISION_IDS: the chain decisions that are the Main Stage. */
export function mainStageDecisionIds(): ReadonlySet<string> {
  return new Set(
    (process.env.MAIN_STAGE_DECISION_IDS ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => /^0x[0-9a-f]{64}$/.test(id))
  );
}

/**
 * ARTIST_ARTWORK_SUBMITTED (`artist-artwork-notifications.ts`): a public
 * Main Stage submission notifies those whose alert on the artist was on
 * before it, who can read the wave and haven't muted it. Never the artist.
 */
export async function deriveSubmissionCreated(
  event: SubmissionCreatedEvent,
  lookups: Pick<
    NotificationLookups,
    'artworkAlertSubscribers' | 'canReadWave' | 'mutedWave'
  >
): Promise<DerivedGroup> {
  const ref = event.entryId;
  if (
    event.anonymous ||
    !mainStageDecisionIds().has(event.chainDecisionId.toLowerCase())
  ) {
    return { family: 'artwork', ref, rows: [] };
  }
  const subscribers = distinctSorted(
    await lookups.artworkAlertSubscribers(event.artistId, event.blockTimeMs)
  ).filter((id) => id !== event.artistId);
  const readers = await lookups.canReadWave(
    event.waveId,
    subscribers,
    event.height
  );
  const muted = await lookups.mutedWave(
    event.waveId,
    subscribers,
    event.blockTimeMs
  );
  return {
    family: 'artwork',
    ref,
    rows: subscribers
      .filter((id) => readers.has(id) && !muted.has(id))
      .map((id) =>
        row(id, event.blockTimeMs, {
          cause: IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED,
          additional_identity_id: event.artistId,
          related_drop_id: event.dropId,
          related_drop_part_no: 1,
          wave_id: event.waveId,
          visibility_group_id: event.visibilityGroupId,
          additional_data: {
            artist_id: event.artistId,
            drop_id: event.dropId,
            wave_id: event.waveId,
            competition_id: event.decisionId,
            entry_id: event.entryId,
            competition_title: event.decisionTitle,
            artwork_title: event.artworkTitle,
            submitted_at: event.blockTimeMs
          }
        })
      )
  };
}
