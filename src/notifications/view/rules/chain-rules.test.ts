import { IdentityNotificationCause } from '@/entities/IIdentityNotification';
import type {
  DecisionResultEvent,
  EntryReleasedEvent,
  PollBallotEvent,
  RatingChangedEvent,
  SubmissionCreatedEvent,
  VoteChangedEvent,
  WaveCreatedEvent
} from '@/notifications/view/notification-sources';
import {
  creditReleaseId,
  DECISION_COMPLETED_EVENT_TYPE,
  decisionCompletedEventId,
  deriveDecisionResult,
  deriveEntryReleased,
  derivePollBallot,
  deriveRating,
  deriveSubmissionCreated,
  deriveVote,
  deriveWaveCreated
} from './chain-rules';

const at = { height: 100, txIndex: 2, blockTimeMs: 1_795_000_000_000 };
const MAIN_STAGE = '0x' + 'a'.repeat(64);
const COMPETITION = '00000000-0000-4000-8000-000000000001';
const SCHEDULED = 1_794_999_000_000;

const rating = (
  over: Partial<RatingChangedEvent> = {}
): RatingChangedEvent => ({
  ...at,
  ref: '0xtx1:REP',
  origin: 'OPERATION',
  matter: 'REP',
  raterId: 'rater',
  targetId: 'target',
  category: 'Art',
  oldValue: 10,
  newValue: 25,
  totalAfter: 300,
  ...over
});

describe('chain notification rules', () => {
  describe('ratings', () => {
    it('notifies the rated profile with today REP fields', () => {
      expect(deriveRating(rating())).toEqual({
        family: 'rating',
        ref: '0xtx1:REP',
        rows: [
          expect.objectContaining({
            identity_id: 'target',
            created_at: at.blockTimeMs,
            cause: IdentityNotificationCause.IDENTITY_REP,
            additional_identity_id: 'rater',
            related_drop_id: null,
            wave_id: null,
            visibility_group_id: null,
            additional_data: {
              amount: 15,
              rater_rating: 25,
              total: 300,
              category: 'Art'
            }
          })
        ]
      });
    });

    it('gives NIC no category', () => {
      const [row] = deriveRating(
        rating({ matter: 'NIC', category: '', newValue: -5, oldValue: 0 })
      ).rows;
      expect(row.cause).toBe(IdentityNotificationCause.IDENTITY_NIC);
      expect(row.additional_data).toEqual({
        amount: -5,
        rater_rating: -5,
        total: 300
      });
    });

    it.each([
      ['an import', { origin: 'IMPORT' as const }],
      ['a scan cut', { origin: 'SCAN' as const }],
      ['no change', { newValue: 10 }],
      ['a self-rating', { raterId: 'target' }]
    ])('derives nothing for %s', (_label, over) => {
      expect(deriveRating(rating(over)).rows).toEqual([]);
    });
  });

  describe('votes', () => {
    const vote = (over: Partial<VoteChangedEvent> = {}): VoteChangedEvent => ({
      ...at,
      ref: '0xtx2',
      origin: 'OPERATION',
      waveId: 'wave',
      visibilityGroupId: 'group',
      entryDropId: 'drop',
      entryAuthorId: 'author',
      voterId: 'voter',
      oldValue: 5,
      newValue: 2,
      entryTotalAfter: 40,
      ...over
    });

    it('notifies the entry author, including for a scan cut', () => {
      for (const origin of ['OPERATION', 'SCAN'] as const) {
        const group = deriveVote(vote({ origin }));
        expect(group.ref).toBe('0xtx2:voter:drop');
        expect(group.rows).toEqual([
          expect.objectContaining({
            identity_id: 'author',
            cause: IdentityNotificationCause.DROP_VOTED,
            additional_identity_id: 'voter',
            related_drop_id: 'drop',
            wave_id: 'wave',
            visibility_group_id: 'group',
            additional_data: { vote: 2, vote_change: -3, total_vote: 40 }
          })
        ]);
      }
    });

    it.each([
      ['an import', { origin: 'IMPORT' as const }],
      ['an unchanged value', { newValue: 5 }],
      ['the author voting', { voterId: 'author' }]
    ])('derives nothing for %s', (_label, over) => {
      expect(deriveVote(vote(over)).rows).toEqual([]);
    });
  });

  describe('poll ballots', () => {
    const ballot = (over: Partial<PollBallotEvent> = {}): PollBallotEvent => ({
      ...at,
      txId: '0xtx3',
      waveId: 'wave',
      visibilityGroupId: null,
      pollDropId: 'poll',
      pollAuthorId: 'author',
      voterId: 'voter',
      anonymous: false,
      oldChoices: [],
      newChoices: [
        { option_no: 2, option_string: 'Two' },
        { option_no: 1, option_string: 'One' }
      ],
      ...over
    });

    it('notifies the poll author with the new choices, in option order', () => {
      expect(derivePollBallot(ballot()).rows).toEqual([
        expect.objectContaining({
          identity_id: 'author',
          cause: IdentityNotificationCause.DROP_POLL_VOTED,
          additional_identity_id: 'voter',
          related_drop_id: 'poll',
          additional_data: {
            poll_options: [
              { option_no: 1, option_string: 'One' },
              { option_no: 2, option_string: 'Two' }
            ]
          }
        })
      ]);
    });

    it.each([
      ['an anonymous poll', { anonymous: true }],
      ['the author voting', { voterId: 'author' }],
      [
        'the same choices in another order',
        {
          oldChoices: [
            { option_no: 1, option_string: 'One' },
            { option_no: 2, option_string: 'Two' }
          ]
        }
      ]
    ])('derives nothing for %s', (_label, over) => {
      expect(derivePollBallot(ballot(over)).rows).toEqual([]);
    });
  });

  describe('wave created', () => {
    const wave = (over: Partial<WaveCreatedEvent> = {}): WaveCreatedEvent => ({
      ...at,
      waveId: 'wave',
      creatorId: 'creator',
      isDirectMessage: false,
      groupIds: ['read-group'],
      ...over
    });
    const lookups = {
      followersListedInGroups: jest.fn(async () => ['b', 'creator', 'a', 'b']),
      membersListedInGroups: jest.fn(async () => ['m2', 'creator', 'm1'])
    };

    it('notifies the creator followers listed in the groups, sorted and once each', async () => {
      const group = await deriveWaveCreated(wave(), lookups);
      expect(lookups.followersListedInGroups).toHaveBeenCalledWith(
        'creator',
        ['read-group'],
        100
      );
      expect(group.rows.map((row) => row.identity_id)).toEqual(['a', 'b']);
      expect(group.rows[0]).toEqual(
        expect.objectContaining({
          cause: IdentityNotificationCause.WAVE_CREATED,
          additional_identity_id: 'creator',
          wave_id: 'wave',
          visibility_group_id: null
        })
      );
    });

    it('notifies DM members, and nobody for a wave without groups', async () => {
      const dm = await deriveWaveCreated(
        wave({ isDirectMessage: true }),
        lookups
      );
      expect(dm.rows.map((row) => row.identity_id)).toEqual(['m1', 'm2']);
      expect(
        (await deriveWaveCreated(wave({ groupIds: [] }), lookups)).rows
      ).toEqual([]);
    });
  });

  describe('decision results', () => {
    const result = (
      over: Partial<DecisionResultEvent> = {}
    ): DecisionResultEvent => ({
      ...at,
      decisionId: COMPETITION,
      occurrence: 3,
      scheduledAtMs: SCHEDULED,
      waveId: 'wave',
      visibilityGroupId: 'group',
      title: 'Main Stage',
      status: 'DECIDED',
      winnerCount: 1,
      ...over
    });
    const lookups = { waveFollowers: jest.fn(async () => ['f2', 'f1']) };

    it('notifies the wave followers of a decided result', async () => {
      const group = await deriveDecisionResult(result(), lookups);
      expect(group.ref).toBe(`${COMPETITION}:3`);
      expect(group.rows.map((row) => row.identity_id)).toEqual(['f1', 'f2']);
      expect(group.rows[0]).toEqual(
        expect.objectContaining({
          cause: IdentityNotificationCause.COMPETITION_LIFECYCLE,
          additional_identity_id: null,
          related_drop_id: null,
          wave_id: 'wave',
          visibility_group_id: 'group',
          additional_data: {
            event_id: decisionCompletedEventId(COMPETITION, SCHEDULED),
            event_type: DECISION_COMPLETED_EVENT_TYPE,
            wave_id: 'wave',
            competition_id: COMPETITION,
            competition_title: 'Main Stage'
          }
        })
      );
    });

    it.each([
      ['a skipped occurrence', { status: 'SKIPPED' as const }],
      ['no winner', { winnerCount: 0 }]
    ])('derives nothing for %s', async (_label, over) => {
      expect((await deriveDecisionResult(result(over), lookups)).rows).toEqual(
        []
      );
    });
  });

  describe('credits returned', () => {
    const released = (
      over: Partial<EntryReleasedEvent> = {}
    ): EntryReleasedEvent => ({
      ...at,
      entryId: 'entry',
      decisionId: COMPETITION,
      decisionTitle: 'Main Stage',
      waveId: 'wave',
      visibilityGroupId: null,
      entryDropId: 'drop',
      submissionTitle: 'Artwork',
      reason: 'WIN',
      creditType: 'TDH',
      creditScope: 'WAVE',
      ...over
    });
    const lookups = {
      entryVoters: jest.fn(async () => [
        { voterId: 'v2', value: -30 },
        { voterId: 'v1', value: 20 },
        { voterId: 'v3', value: 0 }
      ])
    };

    it('returns the absolute vote to every voter with a vote', async () => {
      const group = await deriveEntryReleased(released(), lookups);
      expect(group.rows.map((row) => row.identity_id)).toEqual(['v1', 'v2']);
      expect(group.rows[1]).toEqual(
        expect.objectContaining({
          cause: IdentityNotificationCause.VOTING_CREDITS_RETURNED,
          related_drop_id: null,
          additional_data: {
            event_id: creditReleaseId(COMPETITION, 'entry'),
            reason: 'WIN',
            wave_id: 'wave',
            competition_id: COMPETITION,
            competition_title: 'Main Stage',
            entry_id: 'entry',
            drop_id: 'drop',
            submission_title: 'Artwork',
            credit_type: 'TDH',
            amount: 30,
            released_at: at.blockTimeMs
          }
        })
      );
    });

    it('returns nothing outside wave-scoped credit', async () => {
      expect(
        (await deriveEntryReleased(released({ creditScope: 'ENTRY' }), lookups))
          .rows
      ).toEqual([]);
    });
  });

  describe('artwork submissions', () => {
    const original = process.env.MAIN_STAGE_DECISION_IDS;
    afterEach(() => {
      if (original === undefined) delete process.env.MAIN_STAGE_DECISION_IDS;
      else process.env.MAIN_STAGE_DECISION_IDS = original;
    });
    const submission = (
      over: Partial<SubmissionCreatedEvent> = {}
    ): SubmissionCreatedEvent => ({
      ...at,
      entryId: 'entry',
      chainDecisionId: MAIN_STAGE.toUpperCase().replace('0X', '0x'),
      decisionId: COMPETITION,
      decisionTitle: 'Main Stage',
      waveId: 'wave',
      visibilityGroupId: null,
      dropId: 'drop',
      artistId: 'artist',
      artworkTitle: 'Artwork',
      anonymous: false,
      ...over
    });
    const lookups = {
      artworkAlertSubscribers: jest.fn(async () => [
        's3',
        'artist',
        's1',
        's2'
      ]),
      canReadWave: jest.fn(async () => new Set(['s1', 's2'])),
      mutedWave: jest.fn(async () => new Set(['s2']))
    };

    it('notifies readers who subscribed before and did not mute the wave', async () => {
      process.env.MAIN_STAGE_DECISION_IDS = ` ${MAIN_STAGE} ,not-an-id`;
      const group = await deriveSubmissionCreated(submission(), lookups);
      expect(lookups.artworkAlertSubscribers).toHaveBeenCalledWith(
        'artist',
        at.blockTimeMs
      );
      expect(group.rows.map((row) => row.identity_id)).toEqual(['s1']);
      expect(group.rows[0]).toEqual(
        expect.objectContaining({
          cause: IdentityNotificationCause.ARTIST_ARTWORK_SUBMITTED,
          additional_identity_id: 'artist',
          related_drop_id: 'drop',
          related_drop_part_no: 1,
          additional_data: {
            artist_id: 'artist',
            drop_id: 'drop',
            wave_id: 'wave',
            competition_id: COMPETITION,
            entry_id: 'entry',
            competition_title: 'Main Stage',
            artwork_title: 'Artwork',
            submitted_at: at.blockTimeMs
          }
        })
      );
    });

    it('notifies nobody outside the Main Stage list or for an anonymous entry', async () => {
      delete process.env.MAIN_STAGE_DECISION_IDS;
      expect(
        (await deriveSubmissionCreated(submission(), lookups)).rows
      ).toEqual([]);
      process.env.MAIN_STAGE_DECISION_IDS = MAIN_STAGE;
      expect(
        (
          await deriveSubmissionCreated(
            submission({ anonymous: true }),
            lookups
          )
        ).rows
      ).toEqual([]);
    });
  });
});
