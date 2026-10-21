import * as tables from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { WaveType } from '@/entities/IWave';
import {
  legacyCompetitionEntryId,
  legacyCompetitionId
} from './competition-id';
import { transferCompetitionRetirementHistory } from './competition-retirement-history';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { CompetitionVoteActivityRepository } from './competition-vote-activity.repository';

const wave = aWave(
  { type: WaveType.RANK, time_lock_ms: 2000 },
  { id: 'transfer-overlap-hub', name: 'Transfer overlap', serial_no: 1 }
);
const id = legacyCompetitionId(wave.id);
const dropId = 'transfer-overlap-drop';
const entryId = legacyCompetitionEntryId(id, dropId);
const runtime = new NativeCompetitionRuntimeRepository(() => sqlExecutor);
const activity = new CompetitionVoteActivityRepository(() => sqlExecutor);
const expectedSourceRowsAfterVote = 1;

describeWithSeed(
  'accepted competition history transfer during rolling writes',
  [
    withWaves([wave]),
    {
      table: tables.COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: entryId,
          competition_id: id,
          wave_id: wave.id,
          drop_id: dropId,
          submitter_id: 'artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 0
        }
      ]
    },
    {
      table: tables.COMPETITION_VOTES_TABLE,
      rows: [
        {
          id: 'allocated',
          competition_id: id,
          entry_id: entryId,
          voter_profile_id: 'voter',
          value: 4,
          credit_spent: 4,
          created_at: 1000,
          updated_at: 1000
        }
      ]
    },
    {
      table: tables.DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [
        { id: 1, drop_id: dropId, wave_id: wave.id, timestamp: 1000, vote: 10 }
      ]
    },
    {
      table: tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          id: 2,
          drop_id: dropId,
          wave_id: wave.id,
          voter_id: 'source',
          timestamp: 1000,
          vote: 9
        }
      ]
    },
    {
      table: tables.PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        {
          id: 'zz-retained',
          profile_id: 'historical-voter',
          target_id: dropId,
          additional_data_1: 'artist',
          additional_data_2: wave.id,
          type: 'DROP_VOTE_EDIT',
          created_at: null,
          contents: { oldVote: 13, newVote: 9, reason: 'retained' }
        }
      ]
    },
    {
      table: tables.COMPETITION_MIGRATIONS_TABLE,
      rows: [
        {
          competition_id: id,
          wave_id: wave.id,
          state: 'NATIVE',
          cohort: 'STANDARD',
          owner: 'fixture',
          stage: 'COMPLETE',
          completed_stages: [],
          exceptions: [],
          cutover_at: 3000,
          updated_at: 3000
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      await seedNativeOriginalPrimaryFixture(wave);
    });
    const acceptedVote = () =>
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await runtime.lockCompetition(id, ctx);
        await sqlExecutor.execute(
          `UPDATE ${tables.COMPETITION_VOTES_TABLE} SET value=11,credit_spent=11,updated_at=2000 WHERE competition_id=:id AND entry_id=:entryId`,
          { id, entryId },
          { wrappedConnection: connection }
        );
        await runtime.recordVoteChange(
          {
            competitionId: id,
            entryId,
            voterProfileId: 'voter',
            previousVote: 4,
            value: 11,
            occurredAt: 2000
          },
          ctx
        );
      });

    it('accepts an atomic live vote after the last aggregate copy page and before the single-statement source/target count', async () => {
      let wrote = false;
      const report = await transferCompetitionRetirementHistory(
        sqlExecutor,
        id,
        {},
        {
          onBatch: async (batch) => {
            if (batch.stream === 'AGGREGATE' && !wrote) {
              wrote = true;
              await acceptedVote();
            }
          }
        }
      );
      expect(wrote).toBe(true);
      expect(report).toEqual([
        {
          competition_id: id,
          aggregate_rows: expectedSourceRowsAfterVote,
          voter_rows: expectedSourceRowsAfterVote,
          activity_rows: 2
        }
      ]);
      const scored = await runtime.listHistory(id, {});
      expect(
        scored
          .filter((row) => row.occurred_at === 2000)
          .map((row) => [row.kind, row.aggregate_value, row.value])
      ).toEqual([
        ['AGGREGATE', 11, 0],
        ['VOTER', 0, 11]
      ]);
      const retained = await sqlExecutor.execute(
        `SELECT * FROM ${tables.COMPETITION_SCORE_HISTORY_TABLE} ORDER BY kind,sequence`
      );
      await transferCompetitionRetirementHistory(sqlExecutor, id);
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${tables.COMPETITION_SCORE_HISTORY_TABLE} ORDER BY kind,sequence`
        )
      ).toEqual(retained);
    });

    it('keeps a newly accepted Activity log already scoped even when its exact ID sorts behind the final varchar keyset page', async () => {
      let wrote = false;
      const report = await transferCompetitionRetirementHistory(
        sqlExecutor,
        id,
        {},
        {
          onBatch: async (batch) => {
            if (batch.stream === 'ACTIVITY' && !wrote) {
              wrote = true;
              expect(batch.after).toBe('zz-retained');
              await acceptedVote();
            }
          }
        }
      );
      expect(wrote).toBe(true);
      expect(report[0].activity_rows).toBe(2);
      const logs = await sqlExecutor.execute<{
        id: string;
        competition_id: string;
        created_at: Date | null;
      }>(
        `SELECT id,competition_id,created_at FROM ${tables.PROFILES_ACTIVITY_LOGS_TABLE} ORDER BY id`
      );
      expect(logs.map((row) => [row.id, row.competition_id])).toEqual([
        [`${id}:1`, id],
        ['zz-retained', id]
      ]);
      expect(logs[1].created_at).toBeNull();
      const events = await activity.list(id, 0, 10, {});
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        sequence: 1,
        occurred_at: 2000,
        value: 11
      });
      expect(events[1]).toMatchObject({
        legacy_id: 'zz-retained',
        legacy_created_at: null
      });
      expect(JSON.parse(events[1].legacy_contents!)).toEqual({
        oldVote: 13,
        newVote: 9,
        reason: 'retained'
      });
    });
  }
);
