import {
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISIONS_TABLE
} from '@/constants';
import { LegacyCompetitionAdapter } from '@/competitions/legacy-competition.adapter';
import { legacyCompetitionEntryId } from '@/competitions/competition-id';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { DropType } from '@/entities/IDrop';
import { WaveOutcomeCredit, WaveOutcomeType, WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { wavesApiDb } from '@/api/waves/waves.api.db';

function withRows(table: string, rows: Record<string, unknown>[]): Seed {
  return { table, rows };
}

function drop(id: string, createdAt: number, type: DropType) {
  return {
    id,
    wave_id: 'wave-rank',
    author_id: `author-${id}`,
    created_at: createdAt,
    updated_at: null,
    title: null,
    parts_count: 1,
    reply_to_drop_id: null,
    reply_to_part_id: null,
    drop_type: type,
    signature: null,
    hide_link_preview: false
  };
}

const wave = aWave(
  {
    type: WaveType.RANK,
    decisions_strategy: {
      first_decision_time: 1_000,
      subsequent_decisions: [],
      is_rolling: false
    },
    next_decision_time: null,
    participation_period_start: 1,
    participation_period_end: 10_000,
    voting_period_start: 1,
    voting_period_end: 10_000
  },
  { id: 'wave-rank', name: 'Rank fixture', serial_no: 1 }
);

describeWithSeed(
  'LegacyCompetitionAdapter parity',
  [
    withWaves([wave]),
    withRows(DROPS_TABLE, [
      drop('drop-high', 1, DropType.PARTICIPATORY),
      drop('drop-tie-older', 2, DropType.PARTICIPATORY),
      drop('drop-tie-newer', 3, DropType.PARTICIPATORY),
      drop('drop-winner', 4, DropType.WINNER)
    ]),
    withRows(DROP_RANK_TABLE, [
      {
        drop_id: 'drop-high',
        wave_id: wave.id,
        vote: 60,
        last_increased: 90
      },
      {
        drop_id: 'drop-tie-older',
        wave_id: wave.id,
        vote: 55,
        last_increased: 100
      },
      {
        drop_id: 'drop-tie-newer',
        wave_id: wave.id,
        vote: 55,
        last_increased: 101
      }
    ]),
    withRows(DROP_VOTER_STATE_TABLE, [
      {
        voter_id: 'profile-voter',
        drop_id: 'drop-high',
        votes: 7,
        wave_id: wave.id
      }
    ]),
    withRows(DROPS_VOTES_CREDIT_SPENDINGS_TABLE, [
      {
        id: 1,
        voter_id: 'profile-voter',
        drop_id: 'drop-high',
        credit_spent: 3,
        created_at: 100,
        wave_id: wave.id
      },
      {
        id: 2,
        voter_id: 'profile-voter',
        drop_id: 'drop-high',
        credit_spent: 4,
        created_at: 101,
        wave_id: wave.id
      }
    ]),
    withRows(WAVES_DECISIONS_TABLE, [
      { wave_id: wave.id, decision_time: 1_000 },
      { wave_id: wave.id, decision_time: 2_000 },
      { wave_id: wave.id, decision_time: 3_000 }
    ]),
    withRows(WAVES_DECISION_WINNER_DROPS_TABLE, [
      {
        wave_id: wave.id,
        decision_time: 1_000,
        drop_id: 'drop-winner',
        ranking: 1,
        final_vote: 144,
        prizes: []
      }
    ]),
    withRows(WAVE_OUTCOMES_TABLE, [
      {
        wave_id: wave.id,
        wave_outcome_position: 1,
        type: WaveOutcomeType.MANUAL,
        subtype: null,
        description: 'Winner award',
        credit: WaveOutcomeCredit.CIC,
        rep_category: 'Builder',
        amount: 10
      }
    ]),
    withRows(WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE, [
      {
        wave_id: wave.id,
        wave_outcome_position: 1,
        wave_outcome_distribution_item_position: 1,
        amount: 10,
        description: null
      }
    ]),
    withRows(WAVES_DECISION_PAUSES_TABLE, [
      { id: 1, wave_id: wave.id, start_time: 500, end_time: 600 }
    ])
  ],
  () => {
    const repository = new CompetitionRepository(() => sqlExecutor);

    async function adapter() {
      await repository.backfillLegacyMappings({});
      const [record] = await repository.listCompetitionRecordsForWave(
        wave.id,
        {}
      );
      if (!record) throw new Error('Missing mapping');
      return {
        record,
        reader: new LegacyCompetitionAdapter(repository, wavesApiDb, {})
      };
    }

    it('preserves leaderboard tie order and cursor-safe page boundaries', async () => {
      const { record, reader } = await adapter();
      const first = await reader.listLeaderboard(record, {
        offset: 0,
        limit: 2,
        direction: 'DESC'
      });
      const second = await reader.listLeaderboard(record, {
        offset: 2,
        limit: 2,
        direction: 'DESC'
      });
      expect(first.data.map((item) => item.drop_id)).toEqual([
        'drop-high',
        'drop-tie-older'
      ]);
      expect(first.data.map((item) => item.rank)).toEqual([1, 2]);
      expect(first.has_more).toBe(true);
      expect(second.data.map((item) => item.drop_id)).toEqual([
        'drop-tie-newer'
      ]);
      expect(second.data[0]?.rank).toBe(3);
      expect(
        new Set([...first.data, ...second.data].map((item) => item.entry_id))
          .size
      ).toBe(3);
    });

    it('orders legacy entries by approved rating and rank projections', async () => {
      const { record, reader } = await adapter();
      const byRating = await reader.listEntries(record, {
        offset: 0,
        limit: 10,
        direction: 'DESC',
        sort: 'rating'
      });
      const byRank = await reader.listEntries(record, {
        offset: 0,
        limit: 10,
        direction: 'ASC',
        sort: 'rank'
      });
      expect(byRating.data.map((entry) => entry.drop_id)).toEqual([
        'drop-high',
        'drop-tie-older',
        'drop-tie-newer',
        'drop-winner'
      ]);
      expect(byRank.data.slice(0, 2).map((entry) => entry.rank)).toEqual([
        1, 1
      ]);
      expect(byRank.data.at(-1)?.rank).toBe(3);
    });

    it('preserves winner, decision, outcome, distribution, and pause context', async () => {
      const { record, reader } = await adapter();
      const request = { offset: 0, limit: 50, direction: 'ASC' as const };
      const [winners, decisions, outcomes, pauses] = await Promise.all([
        reader.listWinners(record, request),
        reader.listDecisions(record, request),
        reader.listOutcomes(record, request),
        reader.listPauses(record, request)
      ]);
      expect(winners.data[0]).toMatchObject({
        drop_id: 'drop-winner',
        status: CompetitionEntryStatus.WINNER,
        rank: 1,
        won_at: 1_000
      });
      expect(decisions.data[0]).toMatchObject({
        scheduled_at: 1_000,
        winners: [
          {
            entry_id: legacyCompetitionEntryId(record.id, 'drop-winner'),
            rank: 1,
            final_rating: 144
          }
        ]
      });
      expect(outcomes.data[0]).toMatchObject({
        position: 1,
        legacy_index: 1,
        description: 'Winner award'
      });
      const distribution = await reader.listDistribution(
        record,
        outcomes.data[0]!.id,
        request
      );
      expect(distribution.data).toHaveLength(1);
      expect(pauses.data[0]).toMatchObject({ start_time: 500, end_time: 600 });
    });

    it('paginates decision rounds before fetching their winners', async () => {
      const { record, reader } = await adapter();
      const first = await reader.listDecisions(record, {
        offset: 0,
        limit: 1,
        direction: 'ASC'
      });
      const second = await reader.listDecisions(record, {
        offset: 1,
        limit: 1,
        direction: 'ASC'
      });
      const last = await reader.listDecisions(record, {
        offset: 2,
        limit: 1,
        direction: 'ASC'
      });

      expect(first).toMatchObject({
        data: [{ scheduled_at: 1_000, winners: [{ rank: 1 }] }],
        has_more: true
      });
      expect(second).toMatchObject({
        data: [{ scheduled_at: 2_000, winners: [] }],
        has_more: true
      });
      expect(last).toMatchObject({
        data: [{ scheduled_at: 3_000, winners: [] }],
        has_more: false
      });
    });

    it('preserves vote totals and sums credit spend without multiplying votes', async () => {
      const { record, reader } = await adapter();
      const entryId = legacyCompetitionEntryId(record.id, 'drop-high');
      const request = { offset: 0, limit: 50, direction: 'DESC' as const };
      const [voters, votes] = await Promise.all([
        reader.listVoters(record, request, entryId),
        reader.listEntryVotes(record, entryId, request)
      ]);
      expect(voters.data).toEqual([
        { profile_id: 'profile-voter', votes: 7, credit_spent: 7 }
      ]);
      expect(votes.data[0]).toMatchObject({
        voter_profile_id: 'profile-voter',
        value: 7,
        credit_spent: 7,
        created_at: 100
      });
    });

    it('binds legacy entries to the configuration version at submission time', async () => {
      const { record, reader } = await adapter();
      await repository.ensureLegacyMappingForWave(
        { ...wave, updated_at: 3 },
        {}
      );
      const entries = await reader.listEntries(record, {
        offset: 0,
        limit: 10,
        direction: 'ASC'
      });
      expect(
        Object.fromEntries(
          entries.data.map((entry) => [entry.drop_id, entry.config_version])
        )
      ).toMatchObject({
        'drop-high': 1,
        'drop-tie-older': 1,
        'drop-tie-newer': 2,
        'drop-winner': 2
      });
    });
  }
);
