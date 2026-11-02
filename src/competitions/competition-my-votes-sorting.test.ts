import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  DROPS_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE
} from '@/constants';
import { CompetitionExecutionMode } from '@/entities/ICompetition';
import { ApiCompetitionMyVotesSort } from '@/api/generated/models/ApiCompetitionMyVotesSort';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { CompetitionInteractionRepository } from './competition-interaction.repository';

const record = {
  id: 'aaa00000-0000-4000-8000-000000000002',
  wave_id: 'sorting-wave',
  legacy_wave_id: 'sorting-wave',
  execution_mode: CompetitionExecutionMode.ACTIVE
};
const entries = [
  { id: 'a', value: 10, updated: 700, rank: 3, voted: 100 },
  { id: 'b', value: 30, updated: 500, rank: 1, voted: 400 },
  { id: 'c', value: 30, updated: 500, rank: 1, voted: 400 },
  { id: 'd', value: -5, updated: 100, rank: 2, voted: 200 },
  { id: 'e', value: -1, updated: 200, rank: null, voted: 300 },
  { id: 'f', value: 8, updated: 600, rank: null, voted: null },
  { id: 'z', value: 99, updated: 900, rank: 4, voted: 150 }
];
const entryId = (id: string) => (id === 'b' ? 'entry-zz' : `entry-${id}`);

describeWithSeed(
  'My Votes complete server ordering',
  [
    {
      table: DROPS_TABLE,
      rows: entries.map(({ id }, index) => ({
        id,
        wave_id: record.wave_id,
        serial_no: index + 1,
        author_id: 'artist',
        drop_type: 'CHAT',
        created_at: 900 - index,
        parts_count: 1
      }))
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: entries.map(({ id }, index) => ({
        id: entryId(id),
        competition_id: record.id,
        wave_id: record.wave_id,
        drop_id: id,
        submitter_id: 'artist',
        status: 'ACTIVE',
        config_version: 1,
        submitted_at: 900 - index
      }))
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: entries.map(({ id, value, updated }) => ({
        id: `vote-${id}`,
        competition_id: record.id,
        entry_id: entryId(id),
        voter_profile_id: 'viewer',
        value,
        credit_spent: Math.abs(value),
        created_at: 1,
        updated_at: updated
      }))
    },
    {
      table: COMPETITION_LEADERBOARD_ENTRIES_TABLE,
      rows: entries
        .filter(({ id }) => id !== 'f')
        .map(({ id, rank }) => ({
          competition_id: record.id,
          entry_id: entryId(id),
          drop_id: id,
          rank,
          rating: rank === null ? 0 : 100 - rank,
          real_time_rating: 0,
          submitted_at: 1,
          updated_at: 1
        }))
    },
    {
      table: COMPETITION_VOTE_HISTORY_TABLE,
      rows: entries
        .filter(({ voted }) => voted !== null)
        .map(({ id, value, voted }, index) => ({
          sequence: index + 1,
          competition_id: record.id,
          entry_id: entryId(id),
          drop_id: id,
          voter_profile_id: 'viewer',
          value,
          previous_value: 0,
          aggregate_value: value,
          credit_delta: Math.abs(value),
          occurred_at: voted,
          contents: { oldVote: 0, newVote: value }
        }))
    },
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        {
          id: 'retained-user-change',
          competition_id: record.id,
          profile_id: 'viewer',
          target_id: 'e',
          type: 'DROP_VOTE_EDIT',
          created_at: new Date(600),
          contents: { oldVote: -2, newVote: -1 }
        }
      ]
    }
  ],
  () => {
    const repository = new CompetitionInteractionRepository(() => sqlExecutor);
    const read = async (sort: ApiCompetitionMyVotesSort, legacy = true) => {
      const ids: string[] = [];
      for (let offset = 0; offset < entries.length; offset += 2) {
        ids.push(
          ...(
            await repository.myVotes(
              { ...record, legacy_wave_id: legacy ? record.wave_id : null },
              'viewer',
              offset,
              2,
              {},
              sort
            )
          ).map((row) => row.drop_id)
        );
      }
      return ids;
    };
    it('preserves signed values and existing tie-breakers across pages', async () => {
      expect(await read(ApiCompetitionMyVotesSort.VoteAmount)).toEqual([
        'z',
        'b',
        'c',
        'a',
        'f',
        'e',
        'd'
      ]);
      expect(await repository.myVotes(record, 'viewer', 0, 2, {})).toEqual(
        await repository.myVotes(
          record,
          'viewer',
          0,
          2,
          {},
          ApiCompetitionMyVotesSort.VoteAmount
        )
      );
    });
    it('uses global ranks, puts missing ranks last and preserves leaderboard identity ties', async () => {
      expect(await read(ApiCompetitionMyVotesSort.Leaderboard)).toEqual([
        'b',
        'c',
        'd',
        'a',
        'z',
        'e',
        'f'
      ]);
      expect(await read(ApiCompetitionMyVotesSort.Leaderboard, false)).toEqual([
        'c',
        'b',
        'd',
        'a',
        'z',
        'e',
        'f'
      ]);
    });
    it('uses confirmed history, retained legacy dates and deterministic time ties', async () => {
      // DATETIME retains seconds; use one second for the retained legacy edit.
      await sqlExecutor.execute(
        `UPDATE ${PROFILES_ACTIVITY_LOGS_TABLE} SET created_at='1970-01-01 00:00:01' WHERE id='retained-user-change'`
      );
      expect(await read(ApiCompetitionMyVotesSort.LastVoted)).toEqual([
        'e',
        'b',
        'c',
        'd',
        'z',
        'a',
        'f'
      ]);
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_VOTE_HISTORY_TABLE}
      (competition_id,entry_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at,contents)
      VALUES (:id,'entry-a','viewer',9,10,9,-1,9000,:reason),
        (:id,'entry-a','viewer',9,9,9,0,10000,NULL),
        (:id,'entry-a','other-viewer',20,0,20,20,11000,NULL),
        ('other-competition','entry-a','viewer',30,0,30,30,12000,NULL)`,
        {
          id: record.id,
          reason: JSON.stringify({ reason: 'CREDIT_OVERSPENT' })
        }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${PROFILES_ACTIVITY_LOGS_TABLE}
      (id,competition_id,profile_id,target_id,type,created_at,contents)
      VALUES ('system-adjustment',:id,'viewer','a','DROP_VOTE_EDIT','1970-01-01 00:00:20',:reason),
        ('no-op',:id,'viewer','a','DROP_VOTE_EDIT','1970-01-01 00:00:30',:noop)`,
        {
          id: record.id,
          reason: JSON.stringify({
            oldVote: 10,
            newVote: 9,
            reason: 'CREDIT_OVERSPENT'
          }),
          noop: JSON.stringify({ oldVote: 9, newVote: 9 })
        }
      );
      expect(await read(ApiCompetitionMyVotesSort.LastVoted)).toEqual([
        'e',
        'b',
        'c',
        'd',
        'z',
        'a',
        'f'
      ]);
    });
    it.each(Object.values(ApiCompetitionMyVotesSort))(
      'keeps active nonzero and viewer filtering for %s',
      async (sort) => {
        await sqlExecutor.execute(
          `UPDATE ${COMPETITION_ENTRIES_TABLE} SET status='WINNER' WHERE drop_id='a'`
        );
        await sqlExecutor.execute(
          `UPDATE ${COMPETITION_VOTES_TABLE} SET value=0 WHERE id='vote-b'`
        );
        expect(await read(sort)).not.toEqual(
          expect.arrayContaining(['a', 'b'])
        );
        expect(
          await repository.myVotes(record, 'other-viewer', 0, 50, {}, sort)
        ).toEqual([]);
      }
    );
  }
);
