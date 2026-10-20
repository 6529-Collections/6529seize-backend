import { appFeatures } from '@/app-features';
import { nativeCompetitionRuntimeService } from './native-competition-runtime.service';
import {
  COMPETITIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  COMPETITION_MIGRATION_AUDIT_TABLE,
  DROPS_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROP_RANK_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
} from '@/constants';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { WaveType } from '@/entities/IWave';
import { dropsDb } from '@/drops/drops.db';
import { dropVotingService } from '@/api/drops/drop-voting.service';
import {
  legacyCompetitionId,
  legacyCompetitionEntryId
} from './competition-id';
import { competitionEntryRepository } from './competition-entry.repository';
import { competitionEntryDropHooks } from './competition-entry-drop-hooks';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { withNativeLegacyMirror } from './legacy-competition-mirror';
import { transferCompetitionRetirementHistory } from './competition-retirement-history';
import { nativeScoreSequence } from './competition-score-history';
import {
  legacyGetView,
  installLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';

const wave = aWave(
  {
    type: WaveType.RANK,
    time_lock_ms: 2000,
    participation_period_start: 0,
    voting_period_start: 0
  },
  {
    id: 'history-preparation-wave',
    name: 'Preparatory history preservation',
    serial_no: 1
  }
);
const id = legacyCompetitionId(wave.id);
const dropId = 'history-preparation-drop';
const entryId = legacyCompetitionEntryId(id, dropId);

describeWithSeed(
  'preparatory native history preservation',
  [
    withWaves([wave]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: dropId,
          wave_id: wave.id,
          author_id: 'artist',
          created_at: 0,
          drop_type: 'PARTICIPATORY',
          parts_count: 1,
          hide_link_preview: false
        }
      ]
    },
    {
      table: COMPETITION_ENTRIES_TABLE,
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
      table: COMPETITION_VOTES_TABLE,
      rows: [
        {
          id: 'current-vote',
          competition_id: id,
          entry_id: entryId,
          voter_profile_id: 'voter',
          value: 7,
          credit_spent: 7,
          created_at: 1000,
          updated_at: 2000
        }
      ]
    },
    {
      table: COMPETITION_VOTE_HISTORY_TABLE,
      rows: [
        {
          sequence: 1,
          competition_id: id,
          entry_id: entryId,
          drop_id: dropId,
          submitter_id: 'artist',
          voter_profile_id: 'voter',
          value: 7,
          previous_value: 5,
          aggregate_value: 99,
          credit_delta: 2,
          occurred_at: 2000
        }
      ]
    },
    {
      table: DROP_VOTER_STATE_TABLE,
      rows: [{ drop_id: dropId, wave_id: wave.id, voter_id: 'voter', votes: 7 }]
    },
    {
      table: DROP_RANK_TABLE,
      rows: [
        { drop_id: dropId, wave_id: wave.id, vote: 99, last_increased: 2000 }
      ]
    },
    {
      table: DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: wave.id,
          voter_id: 'voter',
          credit_spent: 7,
          created_at: 2000
        }
      ]
    },
    {
      table: DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [
        { id: 2, drop_id: dropId, wave_id: wave.id, timestamp: 1000, vote: 11 },
        { id: 9, drop_id: dropId, wave_id: wave.id, timestamp: 2000, vote: 99 }
      ]
    },
    {
      table: DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          id: 3,
          drop_id: dropId,
          wave_id: wave.id,
          voter_id: 'voter',
          timestamp: 2000,
          vote: 5
        },
        {
          id: 8,
          drop_id: dropId,
          wave_id: wave.id,
          voter_id: 'voter',
          timestamp: 2000,
          vote: 7
        }
      ]
    },
    {
      table: COMPETITION_MIGRATIONS_TABLE,
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
    },
    {
      table: COMPETITION_MIGRATION_AUDIT_TABLE,
      rows: [
        {
          id: 'historical-cutover',
          competition_id: id,
          actor: 'fixture',
          action: 'CUTOVER',
          reason: 'fixture',
          report: { voteActivityIdentity: 'NATIVE_ID_V1' },
          created_at: 3000
        }
      ]
    }
  ],
  () => {
    const runtime = new NativeCompetitionRuntimeRepository(() => sqlExecutor);
    beforeEach(async () => {
      await seedNativeOriginalPrimaryFixture(wave);
      jest.spyOn(Date, 'now').mockReturnValue(2000);
    });
    afterEach(() => jest.restoreAllMocks());

    it('preserves both raw histories before transfer, resets by their exact independent IDs, and accepts a same-millisecond replacement vote', async () => {
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${COMPETITION_SCORE_HISTORY_TABLE}`
        )
      ).toEqual([]);
      const original = await runtime.listHistory(id, {});
      expect(original).toHaveLength(4);
      await runtime.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await runtime.lockCompetition(id, ctx);
        await withNativeLegacyMirror(sqlExecutor, id, ctx, async () => {
          await dropVotingService.deleteVotes(dropId, ctx, true);
          await sqlExecutor.execute(
            `DELETE FROM ${COMPETITION_VOTES_TABLE} WHERE competition_id=:id`,
            { id },
            { wrappedConnection: connection }
          );
          const entries = await competitionEntryRepository.findDropEntries(
            dropId,
            ctx
          );
          const drop = (await dropsDb.findDropById(dropId, connection))!;
          await competitionEntryDropHooks.recordUpdate(
            { entries, reset_votes: true },
            drop,
            'artist',
            ctx
          );
        });
        expect(await runtime.listHistory(id, ctx)).toEqual([]);
        expect(
          await competitionEntryRepository.voteHistoryReset(id, entryId, ctx)
        ).toEqual({
          vote_history_sequence: 1,
          aggregate_history_sequence: 9,
          voter_history_sequence: 8
        });
        await sqlExecutor.execute(
          `INSERT INTO ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) VALUES ('replacement',:id,:entryId,'voter',11,11,2000,2000)`,
          { id, entryId },
          { wrappedConnection: connection }
        );
        await runtime.recordVoteChange(
          {
            competitionId: id,
            entryId,
            voterProfileId: 'voter',
            previousVote: 0,
            value: 11,
            occurredAt: 2000
          },
          ctx
        );
        expect(
          (await runtime.listHistory(id, ctx)).map((row) => [
            row.kind,
            row.sequence,
            row.aggregate_value,
            row.value,
            row.occurred_at
          ])
        ).toEqual([
          ['AGGREGATE', 10, 11, 0, 2000],
          ['VOTER', 9, 0, 11, 2000]
        ]);
      });
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${DROP_REAL_VOTE_IN_TIME_TABLE} WHERE wave_id=:waveId ORDER BY id`,
          { waveId: wave.id }
        )
      ).toEqual([{ id: 2 }, { id: 9 }, { id: 10 }]);
      expect(
        await sqlExecutor.execute(
          `SELECT id FROM ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} WHERE wave_id=:waveId ORDER BY id`,
          { waveId: wave.id }
        )
      ).toEqual([{ id: 3 }, { id: 8 }, { id: 9 }]);
      expect(
        await sqlExecutor.execute(
          `SELECT sequence FROM ${COMPETITION_VOTE_HISTORY_TABLE} WHERE competition_id=:id ORDER BY sequence`,
          { id }
        )
      ).toEqual([{ sequence: 1 }, { sequence: 2 }]);
      expect(
        await transferCompetitionRetirementHistory(
          sqlExecutor,
          id,
          {},
          { batchSize: 1 }
        )
      ).toEqual([
        {
          competition_id: id,
          aggregate_rows: 3,
          voter_rows: 3,
          activity_rows: 1
        }
      ]);
      expect(
        await sqlExecutor.execute(
          `SELECT kind,sequence,mutation_sequence FROM ${COMPETITION_SCORE_HISTORY_TABLE} WHERE competition_id=:id ORDER BY kind,sequence`,
          { id }
        )
      ).toEqual([
        { kind: 'AGGREGATE', sequence: 2, mutation_sequence: null },
        { kind: 'AGGREGATE', sequence: 9, mutation_sequence: null },
        { kind: 'AGGREGATE', sequence: 10, mutation_sequence: 2 },
        { kind: 'VOTER', sequence: 3, mutation_sequence: null },
        { kind: 'VOTER', sequence: 8, mutation_sequence: null },
        { kind: 'VOTER', sequence: 9, mutation_sequence: 2 }
      ]);
    });

    it('follows the final historical views and resets mixed final and preparatory votes by actual mutation order', async () => {
      await transferCompetitionRetirementHistory(
        sqlExecutor,
        id,
        {},
        { batchSize: 1 }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_VOTE_HISTORY_TABLE} (sequence,competition_id,entry_id,drop_id,submitter_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at)
         VALUES (2,:id,:entryId,:dropId,'artist','voter',13,7,13,6,2000)`,
        { id, entryId, dropId }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at,mutation_sequence)
         VALUES (:id,'AGGREGATE',:sequence,:entryId,:dropId,'',13,2000,2),(:id,'VOTER',:sequence,:entryId,:dropId,'voter',13,2000,2)`,
        { id, entryId, dropId, sequence: nativeScoreSequence(2) }
      );
      try {
        for (const [table, kind] of [
          [DROP_REAL_VOTE_IN_TIME_TABLE, 'AGGREGATE'],
          [DROP_REAL_VOTER_VOTE_IN_TIME_TABLE, 'VOTER']
        ] as const)
          await sqlExecutor.execute(
            `CREATE OR REPLACE SQL SECURITY INVOKER VIEW ${legacyGetView(table)} AS
             SELECT history.sequence AS id,history.drop_id,owner.wave_id,history.value AS vote,history.occurred_at AS timestamp${kind === 'VOTER' ? ',history.voter_profile_id AS voter_id' : ''}
             FROM ${COMPETITION_SCORE_HISTORY_TABLE} history JOIN ${COMPETITIONS_TABLE} owner ON owner.id=history.competition_id
             WHERE history.kind='${kind}'`
          );
        expect(
          (await runtime.listHistory(id, {}))
            .slice(-2)
            .map((row) => [
              row.kind,
              row.sequence,
              row.aggregate_value,
              row.value
            ])
        ).toEqual([
          ['AGGREGATE', nativeScoreSequence(2), 13, 0],
          ['VOTER', nativeScoreSequence(2), 0, 13]
        ]);
        await runtime.executeNativeQueriesInTransaction(async (connection) => {
          const ctx = { connection };
          await runtime.lockCompetition(id, ctx);
          const entries = await competitionEntryRepository.findDropEntries(
            dropId,
            ctx
          );
          const drop = (await dropsDb.findDropById(dropId, connection))!;
          await competitionEntryDropHooks.recordUpdate(
            { entries, reset_votes: true },
            drop,
            'artist',
            ctx
          );
          expect(await runtime.listHistory(id, ctx)).toEqual([]);
          await sqlExecutor.execute(
            `UPDATE ${COMPETITION_VOTES_TABLE} SET value=17,credit_spent=17 WHERE competition_id=:id`,
            { id },
            { wrappedConnection: connection }
          );
          await runtime.recordVoteChange(
            {
              competitionId: id,
              entryId,
              voterProfileId: 'voter',
              previousVote: 0,
              value: 17,
              occurredAt: 2000
            },
            ctx
          );
          expect(
            (await runtime.listHistory(id, ctx)).map((row) => [
              row.kind,
              row.sequence,
              row.aggregate_value,
              row.value
            ])
          ).toEqual([
            ['AGGREGATE', 10, 17, 0],
            ['VOTER', 9, 0, 17]
          ]);
          const active = await runtime.listActiveEntries(id, ctx);
          await runtime.saveLeaderboard(
            id,
            [
              {
                entry: active[0],
                rating: 17,
                rank: 1,
                overThresholdSince: null
              }
            ],
            2000,
            ctx
          );
        });
        expect(
          await sqlExecutor.execute(
            `SELECT published_at FROM ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} WHERE competition_id=:id`,
            { id }
          )
        ).toEqual([{ published_at: 2000 }]);
      } finally {
        await installLegacyCompetitionGetFacade(sqlExecutor);
      }
    });

    it('preserves a delayed old-version transition before replacement and never replays historical boundaries under the new version', async () => {
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      await sqlExecutor.execute(
        `UPDATE ${COMPETITIONS_TABLE} SET participation_config=JSON_SET(participation_config,'$.ends_at',4000),
         voting_config=JSON_SET(voting_config,'$.ends_at',4000) WHERE id=:id`,
        { id }
      );
      await transferCompetitionRetirementHistory(sqlExecutor, id);
      await runtime.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        const old = (await runtime.lockCompetition(id, ctx))!;
        await nativeCompetitionRuntimeService.enqueueDueTransitions(
          old,
          6000,
          ctx
        );
        await sqlExecutor.execute(
          `UPDATE ${COMPETITIONS_TABLE} SET config_version=2,participation_config=JSON_SET(participation_config,'$.ends_at',7000) WHERE id=:id`,
          { id },
          { wrappedConnection: connection }
        );
        await sqlExecutor.execute(
          `INSERT INTO ${COMPETITION_CONFIG_VERSIONS_TABLE} (competition_id,version,config,created_by,created_at) VALUES (:id,2,'{}','fixture',6000)`,
          { id },
          { wrappedConnection: connection }
        );
        const next = (await runtime.lockCompetition(id, ctx))!;
        expect(next.configuration_activated_at).toBe(6000);
        await nativeCompetitionRuntimeService.enqueueDueTransitions(
          next,
          7500,
          ctx
        );
        await nativeCompetitionRuntimeService.enqueueDueTransitions(
          next,
          7500,
          ctx
        );
      });
      expect(
        await sqlExecutor.execute(
          `SELECT semantic_key,delivered_at FROM ${COMPETITION_OUTBOX_TABLE} WHERE competition_id=:id AND semantic_key LIKE :phase ORDER BY semantic_key`,
          { id, phase: `${id}:phase:%` }
        )
      ).toEqual([
        { semantic_key: `${id}:phase:1:0`, delivered_at: 3000 },
        { semantic_key: `${id}:phase:1:4000`, delivered_at: null },
        { semantic_key: `${id}:phase:2:7000`, delivered_at: null }
      ]);
    });

    it('retains signed revision and vote history on membership deletion without leaving a live entry', async () => {
      await runtime.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await runtime.lockCompetition(id, ctx);
        const entries = await competitionEntryRepository.findDropEntries(
          dropId,
          ctx
        );
        const drop = (await dropsDb.findDropById(dropId, connection))!;
        await competitionEntryDropHooks.recordUpdate(
          { entries, reset_votes: true },
          drop,
          'artist',
          ctx
        );
        await withNativeLegacyMirror(sqlExecutor, id, ctx, () =>
          dropVotingService.deleteVotes(dropId, ctx, true)
        );
        await competitionEntryRepository.deleteEntry(entryId, ctx);
      });
      expect(
        await competitionEntryRepository.findDropEntries(dropId, {})
      ).toEqual([]);
      expect(await runtime.listHistory(id, {})).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `SELECT sequence FROM ${COMPETITION_VOTE_HISTORY_TABLE} WHERE competition_id=:id`,
          { id }
        )
      ).toHaveLength(1);
      expect(
        await sqlExecutor.execute(
          `SELECT version FROM ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} WHERE competition_id=:id`,
          { id }
        )
      ).toHaveLength(1);
      expect(
        await transferCompetitionRetirementHistory(sqlExecutor, id)
      ).toEqual([
        {
          competition_id: id,
          aggregate_rows: 2,
          voter_rows: 2,
          activity_rows: 0
        }
      ]);
    });
  }
);
