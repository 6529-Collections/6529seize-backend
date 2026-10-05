import {
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_ENTRIES_TABLE
} from '@/constants';
import {
  CompetitionExecutionMode,
  CompetitionStorageMode
} from '@/entities/ICompetition';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { CompetitionInteractionRepository } from './competition-interaction.repository';
import {
  legacyCompetitionDecisionId,
  legacyCompetitionEntryId
} from './competition-id';

const record = {
  id: 'aaa00000-0000-4000-8000-000000000001',
  wave_id: 'legacy-wave',
  legacy_wave_id: 'legacy-wave',
  storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
  execution_mode: CompetitionExecutionMode.ACTIVE
};
const prize = {
  type: 'MANUAL',
  subtype: null,
  description: 'Immutable award',
  credit: null,
  rep_category: null,
  amount: null
};

describeWithSeed(
  'competition award adapters and personal vote history',
  [
    {
      table: WAVES_DECISION_WINNER_DROPS_TABLE,
      rows: [
        {
          wave_id: record.wave_id,
          decision_time: 100,
          drop_id: 'first',
          ranking: 1,
          final_vote: 40,
          prizes: [
            prize,
            {
              ...prize,
              type: 'AUTOMATIC',
              description: 'REP',
              credit: 'REP',
              amount: 50
            }
          ]
        },
        {
          wave_id: record.wave_id,
          decision_time: 200,
          drop_id: 'second',
          ranking: 1,
          final_vote: 10,
          prizes: [prize]
        },
        {
          wave_id: 'other-wave',
          decision_time: 100,
          drop_id: 'other',
          ranking: 1,
          final_vote: 100,
          prizes: [{ ...prize, description: 'Do not leak' }]
        }
      ]
    },
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: 'first',
          wave_id: record.wave_id,
          author_id: 'artist',
          drop_type: 'WINNER',
          created_at: 1,
          parts_count: 1
        }
      ]
    },
    {
      table: DROP_VOTER_STATE_TABLE,
      rows: [
        {
          wave_id: record.wave_id,
          drop_id: 'first',
          voter_id: 'voter',
          votes: 80
        }
      ]
    },
    {
      table: WINNER_DROP_VOTER_VOTES_TABLE,
      rows: [
        {
          wave_id: record.wave_id,
          drop_id: 'first',
          voter_id: 'voter',
          votes: 40
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: 'ddd00000-0000-4000-8000-000000000001',
          competition_id: record.id,
          wave_id: record.wave_id,
          drop_id: 'first',
          submitter_id: 'artist',
          status: 'WINNER',
          config_version: 1,
          submitted_at: 1
        }
      ]
    },
    {
      table: COMPETITION_OUTCOME_AWARDS_TABLE,
      rows: [
        {
          id: 'bbb00000-0000-4000-8000-000000000001',
          competition_id: record.id,
          decision_id: 'ccc00000-0000-4000-8000-000000000001',
          entry_id: 'ddd00000-0000-4000-8000-000000000001',
          outcome_position: 0,
          award: { ...prize, outcome_position: 0 },
          created_at: 1
        }
      ]
    }
  ],
  () => {
    const repository = new CompetitionInteractionRepository(() => sqlExecutor);
    it('paginates immutable legacy prize descriptors in decision, winner and array order with stable scoped IDs', async () => {
      const first = await repository.awards(record, 0, 2, {});
      const second = await repository.awards(record, 2, 2, {});
      expect(first).toEqual([
        expect.objectContaining({
          ...prize,
          competition_id: record.id,
          decision_id: legacyCompetitionDecisionId(record.id, 100),
          entry_id: legacyCompetitionEntryId(record.id, 'first'),
          outcome_position: 0
        }),
        expect.objectContaining({
          description: 'REP',
          amount: 50,
          outcome_position: 1
        })
      ]);
      expect(second).toEqual([
        expect.objectContaining({
          entry_id: legacyCompetitionEntryId(record.id, 'second'),
          outcome_position: 0
        })
      ]);
      expect(await repository.awards(record, 0, 2, {})).toEqual(first);
      expect(new Set([...first, ...second].map((award) => award.id)).size).toBe(
        3
      );
      expect(
        (
          await repository.awards(
            {
              ...record,
              storage_mode: CompetitionStorageMode.NATIVE,
              legacy_wave_id: null
            },
            0,
            10,
            {}
          )
        )[0].id
      ).toBe('bbb00000-0000-4000-8000-000000000001');
    });
    it('preserves raw submitted winner votes as personal history while final weighted votes remain archived', async () => {
      expect(await repository.myVotes(record, 'voter', 0, 10, {})).toEqual([
        {
          entry_id: legacyCompetitionEntryId(record.id, 'first'),
          drop_id: 'first',
          value: 80,
          credit_spent: 80,
          entry_status: 'WINNER'
        }
      ]);
    });
  }
);
