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
import { withCompetitionProfileMerge } from './competition-profile-merge';
import { retireLegacyCompetitionRuntime } from './competition-runtime-retirement';

const wave = aWave(
  { type: WaveType.RANK, time_lock_ms: 1000 },
  {
    id: 'immutable-retirement-owner',
    name: 'Immutable accepted history',
    serial_no: 1
  }
);
const id = legacyCompetitionId(wave.id);
const entryId = legacyCompetitionEntryId(id, 'immutable-history-drop');

describeWithSeed(
  'immutable retained competition observations',
  [
    withWaves([wave]),
    {
      table: tables.COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: entryId,
          competition_id: id,
          wave_id: wave.id,
          drop_id: 'immutable-history-drop',
          submitter_id: 'author',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 0
        }
      ]
    },
    {
      table: tables.DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [
        {
          id: 1,
          drop_id: 'immutable-history-drop',
          wave_id: wave.id,
          timestamp: 1000,
          vote: 10
        }
      ]
    },
    {
      table: tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          id: 2,
          drop_id: 'immutable-history-drop',
          wave_id: wave.id,
          voter_id: 'source',
          timestamp: 1000,
          vote: 9
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
    const retained = () =>
      sqlExecutor.execute(
        `SELECT * FROM ${tables.COMPETITION_SCORE_HISTORY_TABLE} WHERE competition_id=:id ORDER BY kind,sequence`,
        { id }
      );
    beforeEach(async () => {
      await seedNativeOriginalPrimaryFixture(wave);
      await transferCompetitionRetirementHistory(sqlExecutor, id);
    });

    it('rejects direct stale-source transfer after a native profile consolidation without reverting the accepted voter', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          // The final writer consolidates native data; retained physical sources
          // intentionally remain unchanged once old mirrors have stopped.
          await withCompetitionProfileMerge(
            sqlExecutor,
            ['source'],
            'target',
            async () => undefined,
            { connection }
          );
        }
      );
      expect(
        await sqlExecutor.execute(
          `SELECT voter_id FROM ${tables.DROP_REAL_VOTER_VOTE_IN_TIME_TABLE}`
        )
      ).toEqual([{ voter_id: 'source' }]);
      expect(
        await sqlExecutor.execute(
          `SELECT voter_profile_id FROM ${tables.COMPETITION_SCORE_HISTORY_TABLE} WHERE competition_id=:id AND kind='VOTER'`,
          { id }
        )
      ).toEqual([{ voter_profile_id: 'target' }]);
      const accepted = await retained();
      // The completed native view set is the operational cutover boundary.
      // A repeated transition never reimports now-stale retained sources.
      expect(await retireLegacyCompetitionRuntime(sqlExecutor)).toMatchObject({
        already_retired: true,
        history: []
      });
      expect(await retained()).toEqual(accepted);
      await expect(
        transferCompetitionRetirementHistory(sqlExecutor, id)
      ).rejects.toThrow('Retained VOTER history parity failed');
      expect(await retained()).toEqual(accepted);
    });

    it.each(['value', 'occurred_at'])(
      'rejects conflicting retained %s without silently repairing or overwriting it',
      async (column) => {
        await sqlExecutor.execute(
          `UPDATE ${tables.COMPETITION_SCORE_HISTORY_TABLE} SET \`${column}\`=444 WHERE competition_id=:id AND kind='AGGREGATE'`,
          { id }
        );
        const accepted = await retained();
        await expect(
          transferCompetitionRetirementHistory(sqlExecutor, id)
        ).rejects.toThrow('Retained AGGREGATE history parity failed');
        expect(await retained()).toEqual(accepted);
      }
    );

    it('retains the accepted entry identity when the original membership has since been deleted', async () => {
      await sqlExecutor.execute(
        `DELETE FROM ${tables.COMPETITION_ENTRIES_TABLE} WHERE id=:entryId`,
        { entryId }
      );
      const accepted = await retained();
      await transferCompetitionRetirementHistory(sqlExecutor, id);
      expect(await retained()).toEqual(accepted);
      expect((await retained()).every((row) => row.entry_id === entryId)).toBe(
        true
      );
    });
  }
);
