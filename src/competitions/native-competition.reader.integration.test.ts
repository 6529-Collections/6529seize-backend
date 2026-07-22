import {
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_DECISIONS_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITIONS_TABLE
} from '@/constants';
import { NativeCompetitionReader } from '@/competitions/native-competition.reader';
import { CompetitionRepository } from '@/competitions/competition.repository';
import {
  CompetitionDecisionStatus,
  CompetitionEntryStatus,
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';

function withRows(table: string, rows: Record<string, unknown>[]): Seed {
  return { table, rows };
}

const competitionId = '10000000-0000-4000-8000-000000000001';
const entryId = '10000000-0000-4000-8000-000000000002';
const secondEntryId = '10000000-0000-4000-8000-000000000008';
const voteId = '10000000-0000-4000-8000-000000000003';
const decisionId = '10000000-0000-4000-8000-000000000004';
const outcomeId = '10000000-0000-4000-8000-000000000005';
const distributionId = '10000000-0000-4000-8000-000000000006';
const pauseId = '10000000-0000-4000-8000-000000000007';

const routingRecord = {
  id: competitionId,
  wave_id: 'wave-native',
  legacy_wave_id: null,
  storage_mode: CompetitionStorageMode.NATIVE,
  execution_mode: CompetitionExecutionMode.DISABLED
};

describeWithSeed(
  'NativeCompetitionReader read model',
  [
    withRows(COMPETITIONS_TABLE, [
      {
        ...routingRecord,
        type: CompetitionType.RANK,
        lifecycle: CompetitionLifecycle.PUBLISHED,
        title: 'Native competition',
        description: null,
        participation_config: {
          group_id: null,
          signature_required: false,
          max_entries_per_participant: 1,
          required_metadata: [],
          required_media: [],
          submission_type: null,
          identity_submission_strategy: null,
          identity_submission_duplicates: null,
          starts_at: 100,
          ends_at: 200,
          terms: null
        },
        voting_config: {
          group_id: null,
          credit_type: 'TDH',
          credit_scope: 'WAVE',
          credit_category: null,
          credit_creditor: null,
          credit_nfts: [],
          signature_required: false,
          starts_at: 100,
          ends_at: 300,
          max_votes_per_identity_to_entry: null,
          forbid_negative_votes: false
        },
        decision_config: {
          strategy: null,
          next_decision_time: null,
          winning_min_threshold: null,
          winning_max_threshold: null,
          winning_threshold_min_duration_ms: 0,
          max_winners: 1,
          time_lock_ms: null
        },
        winner_config: {
          max_winners: 1,
          winning_min_threshold: null,
          winning_max_threshold: null,
          winning_threshold_min_duration_ms: 0
        },
        outcome_config: [],
        config_version: 1,
        participation_starts_at: 100,
        participation_ends_at: 200,
        voting_starts_at: 100,
        voting_ends_at: 300,
        created_at: 10,
        updated_at: 20,
        published_at: 10,
        ended_at: null,
        cancelled_at: null,
        archived_at: null
      }
    ]),
    withRows(COMPETITION_CONFIG_VERSIONS_TABLE, [
      {
        competition_id: competitionId,
        version: 1,
        config: { title: 'Native competition' },
        created_by: 'profile-admin',
        created_at: 10
      }
    ]),
    withRows(COMPETITION_ENTRIES_TABLE, [
      {
        id: entryId,
        competition_id: competitionId,
        wave_id: 'wave-native',
        drop_id: 'drop-native',
        submitter_id: 'profile-submitter',
        status: CompetitionEntryStatus.WINNER,
        config_version: 1,
        submitted_at: 110,
        withdrawn_at: null,
        disqualified_at: null,
        won_at: 400,
        rank: 1,
        decision_id: decisionId
      },
      {
        id: secondEntryId,
        competition_id: competitionId,
        wave_id: 'wave-native',
        drop_id: 'drop-native-second',
        submitter_id: 'profile-submitter-second',
        status: CompetitionEntryStatus.ACTIVE,
        config_version: 1,
        submitted_at: 120,
        withdrawn_at: null,
        disqualified_at: null,
        won_at: null,
        rank: null,
        decision_id: null
      }
    ]),
    withRows(COMPETITION_LEADERBOARD_ENTRIES_TABLE, [
      {
        competition_id: competitionId,
        entry_id: entryId,
        drop_id: 'drop-native',
        rating: 50,
        real_time_rating: 55,
        rank: 1,
        submitted_at: 110,
        updated_at: 200
      },
      {
        competition_id: competitionId,
        entry_id: secondEntryId,
        drop_id: 'drop-native-second',
        rating: 60,
        real_time_rating: 60,
        rank: null,
        submitted_at: 120,
        updated_at: 200
      }
    ]),
    withRows(COMPETITION_VOTES_TABLE, [
      {
        id: voteId,
        competition_id: competitionId,
        entry_id: entryId,
        voter_profile_id: 'profile-voter',
        value: 50,
        credit_spent: 5,
        created_at: 150,
        updated_at: 160
      }
    ]),
    withRows(COMPETITION_DECISIONS_TABLE, [
      {
        id: decisionId,
        competition_id: competitionId,
        scheduled_at: 400,
        decided_at: 401,
        status: CompetitionDecisionStatus.COMPLETED,
        execution_key: 'native-decision-one',
        created_at: 401
      }
    ]),
    withRows(COMPETITION_DECISION_WINNERS_TABLE, [
      {
        decision_id: decisionId,
        entry_id: entryId,
        competition_id: competitionId,
        rank: 1,
        final_rating: 50,
        created_at: 401
      }
    ]),
    withRows(COMPETITION_OUTCOMES_TABLE, [
      {
        id: outcomeId,
        competition_id: competitionId,
        decision_id: decisionId,
        position: 1,
        legacy_index: null,
        type: 'MANUAL',
        subtype: null,
        description: 'Native outcome',
        credit: null,
        rep_category: null,
        amount: null,
        created_at: 402
      }
    ]),
    withRows(COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE, [
      {
        id: distributionId,
        competition_id: competitionId,
        outcome_id: outcomeId,
        position: 1,
        amount: 10,
        description: 'First'
      }
    ]),
    withRows(COMPETITION_PAUSES_TABLE, [
      {
        id: pauseId,
        competition_id: competitionId,
        start_time: 250,
        end_time: 260,
        reason: 'Maintenance'
      }
    ])
  ],
  () => {
    const repository = new CompetitionRepository(() => sqlExecutor);
    const reader = new NativeCompetitionReader(repository, {});
    const page = { offset: 0, limit: 50, direction: 'ASC' as const };

    it('reads every Phase 1 native projection while execution is disabled', async () => {
      const [
        competition,
        entries,
        leaderboard,
        voters,
        votes,
        decisions,
        winners,
        outcomes,
        pauses,
        versions
      ] = await Promise.all([
        reader.getCompetition(routingRecord, 150),
        reader.listEntries(routingRecord, page),
        reader.listLeaderboard(routingRecord, page),
        reader.listVoters(routingRecord, page),
        reader.listEntryVotes(routingRecord, entryId, page),
        reader.listDecisions(routingRecord, page),
        reader.listWinners(routingRecord, page),
        reader.listOutcomes(routingRecord, page),
        reader.listPauses(routingRecord, page),
        repository.listConfigVersions(competitionId, page, {})
      ]);
      expect(competition).toMatchObject({
        id: competitionId,
        execution_mode: CompetitionExecutionMode.DISABLED,
        title: 'Native competition'
      });
      expect(entries.data[0]?.id).toBe(entryId);
      expect(leaderboard.data[0]).toMatchObject({ rating: 50, rank: 1 });
      expect(voters.data[0]).toEqual({
        profile_id: 'profile-voter',
        votes: 50,
        credit_spent: 5
      });
      expect(votes.data[0]?.id).toBe(voteId);
      expect(decisions.data[0]?.winners[0]).toMatchObject({
        entry_id: entryId,
        final_rating: 50
      });
      expect(winners.data[0]?.id).toBe(entryId);
      expect(outcomes.data[0]?.id).toBe(outcomeId);
      expect(pauses.data[0]?.id).toBe(pauseId);
      expect(versions.data[0]).toMatchObject({ version: 1 });
      const distribution = await reader.listDistribution(
        routingRecord,
        outcomeId,
        page
      );
      expect(distribution.data[0]?.id).toBe(distributionId);
    });

    it('orders native entries by each approved stable sort', async () => {
      const byRating = await reader.listEntries(routingRecord, {
        ...page,
        direction: 'DESC',
        sort: 'rating'
      });
      const byRank = await reader.listEntries(routingRecord, {
        ...page,
        direction: 'DESC',
        sort: 'rank'
      });
      expect(byRating.data.map((entry) => entry.id)).toEqual([
        secondEntryId,
        entryId
      ]);
      expect(byRank.data.map((entry) => entry.id)).toEqual([
        entryId,
        secondEntryId
      ]);
    });
  }
);
