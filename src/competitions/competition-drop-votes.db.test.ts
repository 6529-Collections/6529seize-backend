import 'reflect-metadata';
import {
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { CompetitionEntry } from './competition.types';
import { CompetitionDropVotesDb } from './competition-drop-votes.db';

const winner: CompetitionEntry = {
  id: 'entry',
  wave_id: 'wave',
  competition_id: 'competition',
  drop_id: 'drop',
  submitter_id: 'author',
  status: CompetitionEntryStatus.WINNER,
  config_version: 1,
  submitted_at: 1,
  rank: 1,
  won_at: 2,
  decision_id: 'decision'
};

describeWithSeed('CompetitionDropVotesDb voter availability', [], () => {
  const db = new CompetitionDropVotesDb(() => sqlExecutor);

  it('does not substitute current votes or another decision for missing winner history', async () => {
    await sqlExecutor.execute(
      `insert into ${COMPETITION_VOTES_TABLE}
       (id, competition_id, entry_id, voter_profile_id, value, credit_spent, created_at, updated_at)
       values ('vote', 'competition', 'entry', 'voter', 42, 42, 1, 1)`
    );
    await sqlExecutor.execute(
      `insert into ${COMPETITION_WINNER_VOTES_TABLE}
       (decision_id, entry_id, voter_profile_id, competition_id, value)
       values ('different-decision', 'entry', 'voter', 'competition', 99)`
    );
    expect(await db.totals(winner, 'voter', {})).toEqual({
      total: 0,
      count: 0,
      user_vote: 0,
      voters_count_available: false
    });
    expect(
      await db.totals(
        { ...winner, status: CompetitionEntryStatus.ACTIVE },
        'voter',
        {}
      )
    ).toEqual({
      total: 42,
      count: 1,
      user_vote: 42,
      voters_count_available: true
    });
  });

  it.each([0, 17])('recognizes a saved winner vote of %s', async (value) => {
    await sqlExecutor.execute(
      `insert into ${COMPETITION_WINNER_VOTES_TABLE}
       (decision_id, entry_id, voter_profile_id, competition_id, value)
       values ('decision', 'entry', 'voter', 'competition', :value)`,
      { value }
    );
    expect(await db.totals(winner, 'voter', {})).toEqual({
      total: value,
      count: value === 0 ? 0 : 1,
      user_vote: value,
      voters_count_available: true
    });
  });
});

const active: CompetitionEntry = {
  ...winner,
  status: CompetitionEntryStatus.ACTIVE,
  rank: null,
  won_at: null,
  decision_id: null
};
const retainedSnapshot = {
  ...active,
  id: 'retained-orphan',
  drop_id: 'retained-orphan-drop'
};
const foreignEntry = {
  ...active,
  id: 'foreign-entry',
  drop_id: 'foreign-drop'
};

describeWithSeed(
  'CompetitionDropVotesDb native score membership',
  [
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        active,
        { ...foreignEntry, competition_id: 'different-competition' }
      ]
    },
    {
      table: COMPETITION_LEADERBOARD_ENTRIES_TABLE,
      rows: [active, retainedSnapshot, foreignEntry].map((entry, index) => ({
        competition_id: entry.competition_id,
        entry_id: entry.id,
        drop_id: entry.drop_id,
        rating: [42, 999, 888][index],
        real_time_rating: [50, 1_000, 900][index],
        rank: index + 1,
        published_at: 2,
        submitted_at: 1,
        updated_at: 2
      }))
    },
    {
      table: COMPETITION_ENTRY_RUNTIME_TABLE,
      rows: [active, retainedSnapshot].map((entry) => ({
        competition_id: entry.competition_id,
        entry_id: entry.id,
        real_time_rating: 50,
        last_increased_at: 1,
        over_threshold_since: 1_234,
        updated_at: 2
      }))
    }
  ],
  () => {
    const db = new CompetitionDropVotesDb(() => sqlExecutor);

    it.each([
      ['no entry exists', retainedSnapshot],
      ['the entry belongs to a different competition', foreignEntry]
    ] as const)(
      'ignores a published leaderboard snapshot when %s',
      async (_description, entry) => {
        expect(await db.score(entry, {})).toBeNull();
      }
    );

    it('preserves a real native entry score and its runtime threshold', async () => {
      expect(await db.score(active, {})).toEqual({
        rating: 42,
        rank: 1,
        over_threshold_since: 1_234
      });
    });
  }
);
