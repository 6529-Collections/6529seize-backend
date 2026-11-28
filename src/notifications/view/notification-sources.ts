/**
 * The source events the notification rules read, fixture-first. They are
 * named after what the notification view needs from the chain indexes and
 * the drop index: the identity mirror's rating log, the waves chain index's
 * event log, the drop index's applied events, and the personal records.
 * The rating log has its adapter (feeds/identity-ratings-feed.ts). The
 * waves index and the drop index are in the codebase; the adapters that
 * map their logs onto these shapes come with the waves feed, and until
 * then tests feed these shapes directly.
 *
 * Every id is a 6529.io id as the indexes store it: profile ids through the
 * identity mirror's principal map, wave, drop and decision ids through the
 * waves index's id map.
 */

/** Where a chain event sits; rules use block time as the row's time. */
export interface ChainPosition {
  readonly height: number;
  readonly txIndex: number;
  readonly blockTimeMs: number;
}

/**
 * Who made a chain change. OPERATION: someone's transaction. SCAN: the
 * chain's own work (a cap's cut, a decision falling due); it notifies only
 * where today's code does. IMPORT: state copied in from 6529.io, or history
 * read again; it never notifies, as 6529.io notified it when it happened.
 * UNKNOWN: a change whose writer the index can't name; it never notifies.
 */
export type ChainOrigin = 'OPERATION' | 'IMPORT' | 'SCAN' | 'UNKNOWN';

/** Whether a chain change of this origin may notify anyone. */
export function originNotifies(origin: ChainOrigin): boolean {
  return origin === 'OPERATION' || origin === 'SCAN';
}

/**
 * Who made a drop index event. IMPORT: a post, edit or reaction copied in
 * from 6529.io, or history read again; it never notifies.
 */
export type RelayOrigin = 'OPERATION' | 'IMPORT';

/** One applied rating change, from the identity mirror's log. */
export interface RatingChangedEvent extends ChainPosition {
  /**
   * Names this change, the same on every read: one per (rater, target,
   * matter, category) change. The mirror's events carry no transaction id.
   */
  readonly ref: string;
  readonly origin: ChainOrigin;
  readonly matter: 'REP' | 'NIC';
  readonly raterId: string;
  readonly targetId: string;
  /** The REP category; empty for NIC. */
  readonly category: string;
  readonly oldValue: number;
  readonly newValue: number;
  /** RatingTotal of (target, matter, category) after the transaction. */
  readonly totalAfter: number;
}

/** A vote's value changed (VOTE_SET, or a scan's cut when origin is SCAN). */
export interface VoteChangedEvent extends ChainPosition {
  /** The transaction id, or the scan unit's id. */
  readonly ref: string;
  readonly origin: ChainOrigin;
  readonly waveId: string;
  readonly visibilityGroupId: string | null;
  readonly entryDropId: string;
  readonly entryAuthorId: string;
  readonly voterId: string;
  readonly oldValue: number;
  readonly newValue: number;
  readonly entryTotalAfter: number;
}

export interface PollChoice {
  readonly option_no: number;
  readonly option_string: string;
}

/** POLL_BALLOT_SET. */
export interface PollBallotEvent extends ChainPosition {
  readonly txId: string;
  readonly origin: ChainOrigin;
  readonly waveId: string;
  readonly visibilityGroupId: string | null;
  readonly pollDropId: string;
  readonly pollAuthorId: string;
  readonly voterId: string;
  readonly anonymous: boolean;
  readonly oldChoices: readonly PollChoice[];
  readonly newChoices: readonly PollChoice[];
}

/** WAVE_CREATE. */
export interface WaveCreatedEvent extends ChainPosition {
  readonly origin: ChainOrigin;
  readonly waveId: string;
  readonly creatorId: string;
  readonly isDirectMessage: boolean;
  /** The wave's read, post, chat and admin groups that are set. */
  readonly groupIds: readonly string[];
}

/** A decision's result became FINAL. */
export interface DecisionResultEvent extends ChainPosition {
  /** SCAN when the decision fell due; IMPORT when copied from 6529.io. */
  readonly origin: ChainOrigin;
  /** The decision's 6529.io competition id (the waves index's id map), shown as competition_id. */
  readonly decisionId: string;
  readonly occurrence: number;
  /** The occurrence's scheduled time; today's decision id derives from it. */
  readonly scheduledAtMs: number;
  /** A transfer's key when the decision was made again for a transfer; else null. */
  readonly decisionKey: string | null;
  readonly waveId: string;
  readonly visibilityGroupId: string | null;
  readonly title: string;
  readonly status: 'DECIDED' | 'SKIPPED';
  readonly winnerCount: number;
}

/** An entry left ACTIVE: it won, or its submitter withdrew it. */
export interface EntryReleasedEvent extends ChainPosition {
  readonly origin: ChainOrigin;
  /** The entry's 6529.io id. */
  readonly entryId: string;
  /** The decision's 6529.io competition id, shown as competition_id. */
  readonly decisionId: string;
  readonly decisionTitle: string;
  readonly waveId: string;
  readonly visibilityGroupId: string | null;
  readonly entryDropId: string;
  readonly submissionTitle: string;
  readonly reason: 'WIN' | 'AUTHOR_DELETED';
  readonly creditType: string;
  /** Today only WAVE-scoped credit returns. */
  readonly creditScope: string;
}

/** SUBMISSION_CREATE. */
export interface SubmissionCreatedEvent extends ChainPosition {
  readonly origin: ChainOrigin;
  readonly entryId: string;
  /** The decision's chain id, matched against MAIN_STAGE_DECISION_IDS. */
  readonly chainDecisionId: string;
  /** The decision's 6529.io competition id, shown as competition_id. */
  readonly decisionId: string;
  readonly decisionTitle: string;
  readonly waveId: string;
  readonly visibilityGroupId: string | null;
  readonly dropId: string;
  readonly artistId: string;
  readonly artworkTitle: string | null;
  readonly anonymous: boolean;
}

/** One REACT event from the drop index, with the reactor's state before it. */
export interface DropReactionEvent {
  readonly eventId: string;
  readonly origin: RelayOrigin;
  /** P33 3.6's effective time. */
  readonly timeMs: number;
  readonly waveId: string;
  readonly visibilityGroupId: string | null;
  readonly dropId: string;
  readonly dropAuthorId: string;
  readonly reactorId: string;
  /** The reaction; `boost` is the reserved boost reaction. */
  readonly reaction: string;
  readonly on: boolean;
  /** The reactor's previous REACT on this drop in P33 3.5's order, if any. */
  readonly previous: { readonly reaction: string; readonly on: boolean } | null;
}

/** A follow record from the subscriber's public stream. */
export interface FollowChangedEvent {
  readonly eventId: string;
  readonly timeMs: number;
  readonly subscriberId: string;
  readonly targetId: string;
  readonly following: boolean;
  /** Whether the subscriber followed the target just before this record. */
  readonly wasFollowing: boolean;
  /** Imported state (the opening follows) notifies nobody. */
  readonly imported: boolean;
}
