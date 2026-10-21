import 'reflect-metadata';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE
} from '@/constants';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { CompetitionEntrySummaryDb } from './competition-entry-summary.db';
import { CompetitionDropVotesDb } from './competition-drop-votes.db';
import { CompetitionRepository } from './competition.repository';
import { CompetitionEntry } from './competition.types';

const entries: CompetitionEntry[] = [
  'active',
  'recent',
  'older',
  'missing'
].map((id, index) => ({
  id,
  competition_id: 'competition',
  wave_id: 'wave',
  drop_id: `drop-${id}`,
  submitter_id: 'artist',
  status: index ? CompetitionEntryStatus.WINNER : CompetitionEntryStatus.ACTIVE,
  config_version: 1,
  submitted_at: 10 - index,
  rank: index ? 1 : null,
  won_at: index ? 100 - index : null,
  decision_id: index ? `decision-${id}` : null
}));
describeWithSeed(
  'batched entry summaries and winner pagination',
  [
    { table: COMPETITION_ENTRIES_TABLE, rows: entries },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: entries.flatMap((entry) =>
        [30, -20, 0, 5, 4, 3, 2].map((value, index) => ({
          id: `${entry.id}-${index}`,
          competition_id: entry.competition_id,
          entry_id: entry.id,
          voter_profile_id: `voter-${index}`,
          value,
          credit_spent: Math.abs(value),
          created_at: 1,
          updated_at: 1
        }))
      )
    },
    {
      table: COMPETITION_WINNER_VOTES_TABLE,
      rows: [
        {
          competition_id: 'competition',
          entry_id: 'recent',
          decision_id: 'decision-recent',
          voter_profile_id: 'voter-0',
          value: 40
        },
        {
          competition_id: 'competition',
          entry_id: 'older',
          decision_id: 'decision-older',
          voter_profile_id: 'voter-0',
          value: 0
        },
        {
          competition_id: 'competition',
          entry_id: 'missing',
          decision_id: 'other-decision',
          voter_profile_id: 'voter-0',
          value: 999
        }
      ]
    },
    {
      table: COMPETITION_DECISION_WINNERS_TABLE,
      rows: entries.slice(1).map((entry) => ({
        competition_id: entry.competition_id,
        entry_id: entry.id,
        decision_id: entry.decision_id,
        rank: 1,
        final_rating: 123,
        created_at: entry.won_at
      }))
    }
  ],
  () => {
    const batch = new CompetitionEntrySummaryDb(() => sqlExecutor);
    const single = new CompetitionDropVotesDb(() => sqlExecutor);
    const repository = new CompetitionRepository(() => sqlExecutor);
    it('matches individual current and at-decision vote reads including missing and zero snapshots', async () => {
      const result = await batch.read(
        'competition',
        entries.map((entry) => entry.id),
        'voter-0',
        {}
      );
      for (const entry of entries) {
        const expected = await single.totals(entry, 'voter-0', {});
        const actual = result.totals.get(entry.id);
        expect(Number(actual?.total ?? 0)).toBe(expected.total);
        expect(Number(actual?.count ?? 0)).toBe(expected.count);
        expect(Number(actual?.user_vote ?? 0)).toBe(expected.user_vote);
        expect(
          entry.status !== 'WINNER' || Number(actual?.snapshot_rows ?? 0) > 0
        ).toBe(expected.voters_count_available);
        const voters = await single.voters(entry, 0, 5, 'DESC', {});
        expect(
          result.voters
            .filter((voter) => voter.entry_id === entry.id)
            .map(({ voter_id, vote }) => ({ voter_id, vote: Number(vote) }))
        ).toEqual(
          voters.map(({ voter_id, vote }) => ({ voter_id, vote: Number(vote) }))
        );
      }
    });
    it('scopes summary and membership reads to the selected competition', async () => {
      const result = await batch.read(
        'other-competition',
        ['active', 'recent'],
        'voter-0',
        {}
      );
      expect(result.totals.size).toBe(0);
      expect(result.scores.size).toBe(0);
      expect(result.voters).toEqual([]);
      expect(
        await repository.findNativeEntriesByIds(
          'other-competition',
          ['active'],
          {}
        )
      ).toEqual([]);
    });
    it('paginates by win time descending rather than submission time', async () => {
      // The earlier submission wins later.
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set won_at=200 where id='older'`
      );
      const page = {
        direction: 'DESC' as const,
        sort: 'won_at' as const,
        offset: 0,
        limit: 1
      };
      const first = await repository.listNativeEntries(
        'competition',
        page,
        {},
        [CompetitionEntryStatus.WINNER]
      );
      const next = await repository.listNativeEntries(
        'competition',
        { ...page, offset: 1 },
        {},
        [CompetitionEntryStatus.WINNER]
      );
      expect(first.data.map((entry) => entry.id)).toEqual(['older']);
      expect(first.has_more).toBe(true);
      expect(next.data.map((entry) => entry.id)).toEqual(['recent']);
    });
  }
);
