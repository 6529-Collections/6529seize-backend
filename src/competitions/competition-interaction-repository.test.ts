import {
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WINNER_DROP_VOTER_VOTES_TABLE,
  COMPETITION_OUTCOME_AWARDS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  COMPETITION_DECISIONS_TABLE
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
  'native competition awards and personal vote history',
  [
    {
      table: DROPS_TABLE,
      rows: ['first', 'second', 'other'].map((id, index) => ({
        id,
        wave_id: id === 'other' ? 'other-wave' : record.wave_id,
        serial_no: index + 1,
        author_id: 'artist',
        drop_type: 'CHAT',
        created_at: index + 1,
        parts_count: 1
      }))
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: ['first', 'second', 'other'].map((dropId, index) => ({
        id: legacyCompetitionEntryId(record.id, dropId),
        competition_id: dropId === 'other' ? 'other-competition' : record.id,
        wave_id: record.wave_id,
        drop_id: dropId,
        submitter_id: 'artist',
        status: 'WINNER',
        config_version: 1,
        submitted_at: index + 1
      }))
    },
    {
      table: COMPETITION_VOTES_TABLE,
      rows: [
        {
          id: 'vote',
          competition_id: record.id,
          entry_id: legacyCompetitionEntryId(record.id, 'first'),
          voter_profile_id: 'voter',
          value: 80,
          credit_spent: 80,
          created_at: 1,
          updated_at: 1
        }
      ]
    },
    {
      table: COMPETITION_WINNER_VOTES_TABLE,
      rows: [
        {
          competition_id: record.id,
          decision_id: legacyCompetitionDecisionId(record.id, 100),
          entry_id: legacyCompetitionEntryId(record.id, 'first'),
          voter_profile_id: 'voter',
          value: 40
        }
      ]
    },
    {
      table: COMPETITION_DECISIONS_TABLE,
      rows: [100, 200].map((time) => ({
        id: legacyCompetitionDecisionId(record.id, time),
        competition_id: record.id,
        scheduled_at: time,
        decided_at: time,
        status: 'COMPLETED',
        execution_key: `decision:${time}`,
        created_at: time
      }))
    },
    {
      table: COMPETITION_OUTCOME_AWARDS_TABLE,
      rows: [
        {
          id: 'award-first-0',
          competition_id: record.id,
          decision_id: legacyCompetitionDecisionId(record.id, 100),
          entry_id: legacyCompetitionEntryId(record.id, 'first'),
          outcome_position: 0,
          award: prize,
          created_at: 100
        },
        {
          id: 'award-first-1',
          competition_id: record.id,
          decision_id: legacyCompetitionDecisionId(record.id, 100),
          entry_id: legacyCompetitionEntryId(record.id, 'first'),
          outcome_position: 1,
          award: {
            ...prize,
            type: 'AUTOMATIC',
            description: 'REP',
            credit: 'REP',
            amount: 50
          },
          created_at: 100
        },
        {
          id: 'award-second-0',
          competition_id: record.id,
          decision_id: legacyCompetitionDecisionId(record.id, 200),
          entry_id: legacyCompetitionEntryId(record.id, 'second'),
          outcome_position: 0,
          award: prize,
          created_at: 200
        },
        {
          id: 'award-other-0',
          competition_id: 'other-competition',
          decision_id: 'other-decision',
          entry_id: legacyCompetitionEntryId(record.id, 'other'),
          outcome_position: 0,
          award: { ...prize, description: 'Do not leak' },
          created_at: 1
        }
      ]
    }
  ],
  () => {
    const repository = new CompetitionInteractionRepository(() => sqlExecutor);
    it('paginates retained immutable prize descriptors in decision, winner and array order with stable scoped IDs', async () => {
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
    });
    it('excludes winners from active personal votes while preserving their recorded votes', async () => {
      expect(await repository.myVotes(record, 'voter', 0, 10, {})).toEqual([]);
      const retained = await sqlExecutor.execute<{ value: number }>(
        `select value from ${COMPETITION_VOTES_TABLE} where id='vote'`,
        {}
      );
      expect(Number(retained[0].value)).toBe(80);
    });
  }
);
