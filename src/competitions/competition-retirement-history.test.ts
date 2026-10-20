import {
  COMPETITIONS_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_VOTE_HISTORY_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_SCORE_HISTORY_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  COMPETITION_MIGRATION_AUDIT_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE
} from '@/constants';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { WaveType } from '@/entities/IWave';
import {
  legacyCompetitionId,
  legacyCompetitionEntryId
} from './competition-id';
import { transferCompetitionRetirementHistory } from './competition-retirement-history';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { CompetitionVoteActivityRepository } from './competition-vote-activity.repository';
import { flooredWeightedNativeVote } from './native-competition-runtime.helpers';
import { nativeScoreSequence } from './competition-score-history';
import { nativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionEntryRepository } from './competition-entry.repository';
import { withLegacyCompetitionGetFacade } from './legacy-competition-get-facade';

const wave = aWave(
  {
    type: WaveType.RANK,
    time_lock_ms: 2000,
    participation_period_start: 0,
    voting_period_start: 0
  },
  { id: 'retirement-history-wave', name: 'History parity', serial_no: 1 }
);
const competitionId = legacyCompetitionId(wave.id);
const entryId = legacyCompetitionEntryId(competitionId, 'drop-a');
const aggregate = [
  { id: 12, drop_id: 'drop-a', timestamp: 1000, vote: 100 },
  { id: 3, drop_id: 'drop-a', timestamp: 1000, vote: -3 },
  { id: 21, drop_id: 'drop-a', timestamp: 2000, vote: 999 },
  { id: 22, drop_id: 'deleted-source-drop', timestamp: 2500, vote: 77 }
];
const voter = [
  { id: 7, drop_id: 'drop-a', timestamp: 1000, voter_id: 'voter', vote: 9 },
  { id: 8, drop_id: 'drop-a', timestamp: 2000, voter_id: 'voter', vote: 0 },
  { id: 9, drop_id: 'drop-a', timestamp: 2000, voter_id: 'voter', vote: 400 }
];

describeWithSeed(
  'competition history retirement parity',
  [
    withWaves([wave]),
    {
      table: COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: entryId,
          competition_id: competitionId,
          wave_id: wave.id,
          drop_id: 'drop-a',
          submitter_id: 'artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 0
        }
      ]
    },
    {
      table: DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: aggregate.map((row) => ({ ...row, wave_id: wave.id }))
    },
    {
      table: DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: voter.map((row) => ({ ...row, wave_id: wave.id }))
    },
    {
      table: COMPETITION_MIGRATIONS_TABLE,
      rows: [
        {
          competition_id: competitionId,
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
          id: 'old-cutover',
          competition_id: competitionId,
          actor: 'fixture',
          action: 'CUTOVER',
          reason: 'historical',
          report: {},
          created_at: 3000
        }
      ]
    },
    {
      table: PROFILES_ACTIVITY_LOGS_TABLE,
      rows: [
        {
          id: 'retained-original',
          profile_id: 'voter',
          target_id: 'deleted-source-drop',
          additional_data_1: 'artist',
          additional_data_2: wave.id,
          proxy_id: 'proxy',
          type: 'DROP_VOTE_EDIT',
          created_at: '1970-01-01 00:00:02',
          contents: { oldVote: '40', newVote: 9, reason: 'CREDIT_OVERSPENT' }
        },
        {
          id: 'unlinked-after-old-cutover',
          profile_id: 'voter',
          target_id: 'drop-a',
          additional_data_1: 'artist',
          additional_data_2: wave.id,
          type: 'DROP_VOTE_EDIT',
          created_at: '1970-01-01 00:00:04',
          contents: { oldVote: 9, newVote: 8 }
        },
        {
          id: `${competitionId}:1`,
          profile_id: 'voter',
          target_id: 'drop-a',
          additional_data_1: 'artist',
          additional_data_2: wave.id,
          proxy_id: 'proxy',
          type: 'DROP_VOTE_EDIT',
          created_at: '1970-01-01 00:00:04',
          contents: { oldVote: 9, newVote: 8, reason: 'exact-native' }
        }
      ]
    },
    {
      table: COMPETITION_VOTE_HISTORY_TABLE,
      rows: [
        {
          sequence: 1,
          competition_id: competitionId,
          entry_id: entryId,
          voter_profile_id: 'voter',
          previous_value: 9,
          value: 8,
          aggregate_value: 8,
          credit_delta: -1,
          occurred_at: 4123
        }
      ]
    }
  ],
  () => {
    const runtime = new NativeCompetitionRuntimeRepository(() => sqlExecutor);
    const activity = new CompetitionVoteActivityRepository(() => sqlExecutor);
    beforeEach(async () => {
      await seedNativeOriginalPrimaryFixture(wave);
      await sqlExecutor.execute(
        `UPDATE ${COMPETITION_CONFIG_VERSIONS_TABLE} SET created_at=3000 WHERE competition_id=:competitionId`,
        { competitionId }
      );
    });

    it('transfers mismatched aggregate and voter streams independently with exact source identities and time order', async () => {
      expect(
        await transferCompetitionRetirementHistory(sqlExecutor, competitionId)
      ).toEqual([
        {
          competition_id: competitionId,
          aggregate_rows: 4,
          voter_rows: 3,
          activity_rows: 3
        }
      ]);
      const history = await runtime.listHistory(competitionId, {});
      expect(
        history.map((row) => [
          row.kind,
          row.sequence,
          row.occurred_at,
          row.kind === 'AGGREGATE' ? row.aggregate_value : row.value
        ])
      ).toEqual([
        ['AGGREGATE', 3, 1000, -3],
        ['VOTER', 7, 1000, 9],
        ['AGGREGATE', 12, 1000, 100],
        ['VOTER', 8, 2000, 0],
        ['VOTER', 9, 2000, 400],
        ['AGGREGATE', 21, 2000, 999]
      ]);
      for (const time of [999, 1000, 1001, 1999, 2000, 2500, 4000]) {
        const expectedAggregate = aggregate
          .filter((row) => row.drop_id === 'drop-a')
          .map((row) => ({
            timestamp: row.timestamp,
            vote: row.vote,
            sequence: row.id
          }));
        const expectedVoter = voter.map((row) => ({
          timestamp: row.timestamp,
          vote: row.vote,
          sequence: row.id
        }));
        const actual = (kind: 'AGGREGATE' | 'VOTER') =>
          history
            .filter((row) => row.kind === kind)
            .map((row) => ({
              timestamp: row.occurred_at,
              vote: kind === 'AGGREGATE' ? row.aggregate_value : row.value,
              sequence: row.sequence
            }));
        expect(flooredWeightedNativeVote(actual('AGGREGATE'), time, 2000)).toBe(
          flooredWeightedNativeVote(expectedAggregate, time, 2000)
        );
        expect(flooredWeightedNativeVote(actual('VOTER'), time, 2000)).toBe(
          flooredWeightedNativeVote(expectedVoter, time, 2000)
        );
      }
      expect(
        await sqlExecutor.execute(
          `SELECT sequence,drop_id,entry_id FROM ${COMPETITION_SCORE_HISTORY_TABLE} WHERE drop_id='deleted-source-drop'`
        )
      ).toEqual([
        { sequence: 22, drop_id: 'deleted-source-drop', entry_id: null }
      ]);
      const snapshot = await sqlExecutor.execute(
        `SELECT * FROM ${COMPETITION_SCORE_HISTORY_TABLE} ORDER BY kind,sequence`
      );
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${COMPETITION_SCORE_HISTORY_TABLE} ORDER BY kind,sequence`
        )
      ).toEqual(snapshot);
    });

    it('commits bounded batches and permits a concurrent preparatory vote before continuing the transfer', async () => {
      const batches: { stream: string; rows: number }[] = [];
      let inserted = false;
      const report = await transferCompetitionRetirementHistory(
        sqlExecutor,
        competitionId,
        {},
        {
          batchSize: 1,
          onBatch: async (progress) => {
            batches.push(progress);
            if (inserted || progress.stream !== 'AGGREGATE') return;
            inserted = true;
            await sqlExecutor.executeNativeQueriesInTransaction(
              async (connection) => {
                const options = { wrappedConnection: connection };
                // NOWAIT fails immediately if the transfer still owns its row lock.
                await sqlExecutor.execute(
                  `SELECT id FROM ${COMPETITIONS_TABLE} WHERE id=:competitionId FOR UPDATE NOWAIT`,
                  { competitionId },
                  options
                );
                await sqlExecutor.execute(
                  `INSERT INTO ${DROP_REAL_VOTE_IN_TIME_TABLE} (id,wave_id,drop_id,timestamp,vote) VALUES (50,:waveId,'drop-a',6000,444)`,
                  { waveId: wave.id },
                  options
                );
                await sqlExecutor.execute(
                  `INSERT INTO ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (id,wave_id,drop_id,voter_id,timestamp,vote) VALUES (51,:waveId,'drop-a','voter',6000,444)`,
                  { waveId: wave.id },
                  options
                );
                await sqlExecutor.execute(
                  `INSERT INTO ${COMPETITION_VOTE_HISTORY_TABLE} (sequence,competition_id,entry_id,voter_profile_id,value,previous_value,aggregate_value,credit_delta,occurred_at) VALUES (2,:competitionId,:entryId,'voter',444,8,444,436,6000)`,
                  { competitionId, entryId },
                  options
                );
                await sqlExecutor.execute(
                  `INSERT INTO ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at,mutation_sequence) VALUES (:competitionId,'AGGREGATE',50,:entryId,'drop-a','',444,6000,2),(:competitionId,'VOTER',51,:entryId,'drop-a','voter',444,6000,2)`,
                  { competitionId, entryId },
                  options
                );
              }
            );
          }
        }
      );
      expect(inserted).toBe(true);
      expect(batches.every((batch) => batch.rows === 1)).toBe(true);
      expect(
        batches.filter((batch) => batch.stream === 'AGGREGATE')
      ).toHaveLength(5);
      expect(batches.filter((batch) => batch.stream === 'VOTER')).toHaveLength(
        4
      );
      expect(report).toEqual([
        {
          competition_id: competitionId,
          aggregate_rows: 5,
          voter_rows: 4,
          activity_rows: 3
        }
      ]);
      expect(
        (await runtime.listHistory(competitionId, {}))
          .filter((row) => row.occurred_at === 6000)
          .map((row) => row.sequence)
      ).toEqual([50, 51]);
    });

    it('transfers native-born history without deriving aggregate values from voter observations or importing wave history', async () => {
      await sqlExecutor.execute(
        `UPDATE ${COMPETITIONS_TABLE} SET legacy_wave_id=NULL WHERE id=:competitionId`,
        { competitionId }
      );
      await sqlExecutor.execute(
        `UPDATE ${COMPETITION_VOTE_HISTORY_TABLE} SET aggregate_value=777 WHERE competition_id=:competitionId`,
        { competitionId }
      );
      expect(
        await transferCompetitionRetirementHistory(sqlExecutor, competitionId)
      ).toEqual([
        {
          competition_id: competitionId,
          aggregate_rows: 1,
          voter_rows: 1,
          activity_rows: 0
        }
      ]);
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      const history = await runtime.listHistory(competitionId, {});
      expect(history).toHaveLength(2);
      expect(
        history.map((row) => [
          row.kind,
          row.sequence,
          row.aggregate_value,
          row.value
        ])
      ).toEqual([
        ['AGGREGATE', nativeScoreSequence(1), 777, 0],
        ['VOTER', nativeScoreSequence(1), 0, 8]
      ]);
    });

    it('rejects an incorrect native mutation link even when score values and timestamps match exactly', async () => {
      await sqlExecutor.execute(
        `UPDATE ${COMPETITIONS_TABLE} SET legacy_wave_id=NULL WHERE id=:competitionId`,
        { competitionId }
      );
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      await sqlExecutor.execute(
        `UPDATE ${COMPETITION_SCORE_HISTORY_TABLE} SET mutation_sequence=NULL
         WHERE competition_id=:competitionId AND kind='AGGREGATE' AND sequence=:sequence`,
        { competitionId, sequence: nativeScoreSequence(1) }
      );
      await expect(
        transferCompetitionRetirementHistory(sqlExecutor, competitionId)
      ).rejects.toThrow('Native AGGREGATE history parity failed');
    });

    it('retains native-born observations, activity context and signed revisions after membership deletion before historical transfer', async () => {
      await sqlExecutor.execute(
        `UPDATE ${COMPETITIONS_TABLE} SET legacy_wave_id=NULL WHERE id=:competitionId`,
        { competitionId }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE}
         (entry_id,version,competition_id,drop_id,content,signature_message,signature,signed_payload,signed_content,actor_id,created_at)
         VALUES (:entryId,1,:competitionId,'drop-a',:content,'original message','original signature',:payload,:signedContent,'artist',1000)`,
        {
          competitionId,
          entryId,
          content: JSON.stringify({ title: 'private retained revision' }),
          payload: JSON.stringify({ original: 'signed payload' }),
          signedContent: JSON.stringify({ body: 'original bytes' })
        }
      );
      const signed = await sqlExecutor.execute(
        `SELECT * FROM ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} WHERE entry_id=:entryId`,
        { entryId }
      );
      await runtime.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await runtime.lockCompetition(competitionId, ctx);
        await sqlExecutor.execute(
          `INSERT INTO ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at)
           VALUES ('accepted-before-delete',:competitionId,:entryId,'voter',11,11,5000,5000)`,
          { competitionId, entryId },
          { wrappedConnection: connection }
        );
        await runtime.recordVoteChange(
          {
            competitionId,
            entryId,
            voterProfileId: 'voter',
            previousVote: 8,
            value: 11,
            occurredAt: 5000,
            proxyId: 'original-proxy',
            reason: 'CREDIT_OVERSPENT'
          },
          ctx
        );
        await competitionEntryRepository.deleteEntry(entryId, ctx);
      });
      expect(
        await competitionEntryRepository.findDropEntries('drop-a', {})
      ).toEqual([]);
      expect(await runtime.listHistory(competitionId, {})).toEqual([]);
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} WHERE entry_id=:entryId`,
          { entryId }
        )
      ).toEqual(signed);
      expect(
        await transferCompetitionRetirementHistory(
          sqlExecutor,
          competitionId,
          {},
          { batchSize: 1 }
        )
      ).toEqual([
        {
          competition_id: competitionId,
          aggregate_rows: 2,
          voter_rows: 2,
          activity_rows: 0
        }
      ]);
      expect(await runtime.listHistory(competitionId, {})).toEqual([]);
      const history = await sqlExecutor.execute(
        `SELECT kind,value,drop_id FROM ${COMPETITION_SCORE_HISTORY_TABLE} WHERE competition_id=:competitionId ORDER BY sequence,kind`,
        { competitionId }
      );
      expect(history).toEqual([
        { kind: 'AGGREGATE', value: 8, drop_id: 'drop-a' },
        { kind: 'VOTER', value: 8, drop_id: 'drop-a' },
        { kind: 'AGGREGATE', value: 11, drop_id: 'drop-a' },
        { kind: 'VOTER', value: 11, drop_id: 'drop-a' }
      ]);
      const rows = await activity.list(competitionId, 0, 20, {});
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        sequence: 2,
        drop_id: 'drop-a',
        submitter_id: 'artist',
        proxy_id: 'original-proxy',
        occurred_at: 5000
      });
      expect(JSON.parse(rows[0].legacy_contents!)).toEqual({
        oldVote: 8,
        newVote: 11,
        reason: 'CREDIT_OVERSPENT'
      });
      await transferCompetitionRetirementHistory(
        sqlExecutor,
        competitionId,
        {},
        { batchSize: 1 }
      );
      expect(await activity.list(competitionId, 0, 20, {})).toEqual(rows);
    });

    it('preserves accepted order when preparatory and final writers alternate in the same millisecond', async () => {
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      const observations = [
        {
          sequence: nativeScoreSequence(10),
          mutation_sequence: 10,
          value: 100
        },
        { sequence: 31, mutation_sequence: 11, value: 200 },
        {
          sequence: nativeScoreSequence(12),
          mutation_sequence: 12,
          value: 300
        },
        { sequence: 32, mutation_sequence: 13, value: 400 }
      ];
      for (const observation of observations) {
        await sqlExecutor.execute(
          `INSERT INTO ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at,mutation_sequence) VALUES (:competitionId,'AGGREGATE',:sequence,:entryId,'drop-a','',:value,5000,:mutation_sequence)`,
          { competitionId, entryId, ...observation }
        );
        if (observation.sequence < 100)
          await sqlExecutor.execute(
            `INSERT INTO ${DROP_REAL_VOTE_IN_TIME_TABLE} (id,wave_id,drop_id,timestamp,vote) VALUES (:sequence,:waveId,'drop-a',5000,:value)`,
            { ...observation, waveId: wave.id }
          );
      }
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      const actual = (await runtime.listHistory(competitionId, {})).filter(
        (row) => row.occurred_at === 5000
      );
      expect(actual.map((row) => row.sequence)).toEqual(
        observations.map((row) => row.sequence)
      );
      expect(
        flooredWeightedNativeVote(
          actual.map((row) => ({
            timestamp: row.occurred_at,
            vote: row.aggregate_value,
            sequence: row.order_sequence ?? row.sequence
          })),
          5000,
          0
        )
      ).toBe(400);
    });

    it('resets a submission revision by independent watermarks and accepts a new vote in the same millisecond while retaining public history', async () => {
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      const publicHistory = () =>
        withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `SELECT id,timestamp,vote FROM ${DROP_REAL_VOTE_IN_TIME_TABLE} WHERE wave_id=:waveId ORDER BY timestamp,id`,
            { waveId: wave.id }
          )
        );
      const retained = await publicHistory();
      const activityBefore = await activity.list(competitionId, 0, 20, {});
      await runtime.executeNativeQueriesInTransaction(async (connection) => {
        const ctx = { connection };
        await runtime.lockCompetition(competitionId, ctx);
        await runtime.enqueueEvent(
          {
            key: `entry-content:${entryId}:1`,
            event_type: 'COMPETITION_ENTRY_UPDATED',
            competition_id: competitionId,
            wave_id: wave.id,
            competition_entry_id: entryId,
            occurred_at: 9999,
            data: { content_revision: 1 }
          },
          ctx
        );
        expect(await runtime.listHistory(competitionId, ctx)).toHaveLength(6);
        const boundary = await competitionEntryRepository.voteHistoryReset(
          competitionId,
          entryId,
          ctx
        );
        expect(boundary).toEqual({
          vote_history_sequence: 1,
          aggregate_history_sequence: 21,
          voter_history_sequence: 9
        });
        await runtime.enqueueEvent(
          {
            key: `entry-content:${entryId}:2`,
            event_type: 'COMPETITION_ENTRY_UPDATED',
            competition_id: competitionId,
            wave_id: wave.id,
            competition_entry_id: entryId,
            occurred_at: 2000,
            data: { content_revision: 2, ...boundary }
          },
          ctx
        );
        expect(await runtime.listHistory(competitionId, ctx)).toEqual([]);
        await sqlExecutor.execute(
          `INSERT INTO ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) VALUES ('after-edit',:competitionId,:entryId,'voter',11,11,2000,2000)`,
          { competitionId, entryId },
          { wrappedConnection: connection }
        );
        await runtime.recordVoteChange(
          {
            competitionId,
            entryId,
            voterProfileId: 'voter',
            previousVote: 0,
            value: 11,
            occurredAt: 2000
          },
          ctx
        );
        const scored = await runtime.listHistory(competitionId, ctx);
        expect(
          scored.map((row) => [
            row.kind,
            row.occurred_at,
            row.aggregate_value,
            row.value
          ])
        ).toEqual([
          ['AGGREGATE', 2000, 11, 0],
          ['VOTER', 2000, 0, 11]
        ]);
      });
      const publicAfter = await publicHistory();
      expect(publicAfter).toHaveLength(retained.length + 1);
      expect(publicAfter).toEqual(expect.arrayContaining(retained));
      expect(await activity.list(competitionId, 0, 20, {})).toEqual(
        expect.arrayContaining(activityBefore)
      );
      expect(
        await sqlExecutor.execute(
          `SELECT sequence FROM ${COMPETITION_VOTE_HISTORY_TABLE} WHERE competition_id=:competitionId`,
          { competitionId }
        )
      ).toHaveLength(2);
    });

    it('preserves exact activity and scoring after obsolete history and migration tables are absent', async () => {
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      const expectedHistory = await runtime.listHistory(competitionId, {});
      const expectedActivity = await activity.list(competitionId, 0, 20, {});
      expect(
        expectedActivity.map(
          (row) => row.legacy_id ?? `${competitionId}:${row.sequence}`
        )
      ).toEqual([
        `${competitionId}:1`,
        'unlinked-after-old-cutover',
        'retained-original'
      ]);
      expect(expectedActivity[0]).toMatchObject({
        occurred_at: 4123,
        proxy_id: 'proxy'
      });
      expect(JSON.parse(expectedActivity[0].legacy_contents!)).toEqual({
        oldVote: 9,
        newVote: 8,
        reason: 'exact-native'
      });
      const obsolete = [
        DROP_REAL_VOTE_IN_TIME_TABLE,
        DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
        COMPETITION_MIGRATIONS_TABLE,
        COMPETITION_MIGRATION_AUDIT_TABLE
      ];
      const renamed: string[] = [];
      try {
        for (const table of obsolete) {
          await sqlExecutor.execute(
            `RENAME TABLE ${table} TO disposable_retired_${table}`
          );
          renamed.push(table);
        }
        expect(await runtime.listHistory(competitionId, {})).toEqual(
          expectedHistory
        );
        expect(await activity.list(competitionId, 0, 20, {})).toEqual(
          expectedActivity
        );
        expect(await activity.list(competitionId, 1, 1, {})).toEqual(
          expectedActivity.slice(1, 2)
        );
        await sqlExecutor.execute(
          `INSERT INTO ${COMPETITION_SCORE_HISTORY_TABLE} (competition_id,kind,sequence,entry_id,drop_id,voter_profile_id,value,occurred_at) VALUES (:competitionId,'AGGREGATE',:sequence,:entryId,'drop-a','',123,5000)`,
          { competitionId, entryId, sequence: nativeScoreSequence(2) }
        );
        expect(
          (await runtime.listHistory(competitionId, {})).at(-1)
        ).toMatchObject({ aggregate_value: 123, occurred_at: 5000 });
      } finally {
        for (const table of renamed.reverse())
          await sqlExecutor.execute(
            `RENAME TABLE disposable_retired_${table} TO ${table}`
          );
      }
    });

    it('keeps all accepted post-cutover shared activity with old audit labels and exact-ID deduplication', async () => {
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      const rows = await activity.list(competitionId, 0, 20, {});
      expect(
        rows.map((row) => row.legacy_id ?? `${competitionId}:${row.sequence}`)
      ).toEqual([
        `${competitionId}:1`,
        'unlinked-after-old-cutover',
        'retained-original'
      ]);
      expect(
        new Set(rows.map((row) => row.legacy_id ?? row.sequence)).size
      ).toBe(3);
    });

    it('fails explicitly when a shared primary log is already attributed to another competition', async () => {
      await sqlExecutor.execute(
        `UPDATE ${PROFILES_ACTIVITY_LOGS_TABLE} SET competition_id='another-competition' WHERE id='unlinked-after-old-cutover'`
      );
      await expect(
        transferCompetitionRetirementHistory(sqlExecutor, competitionId)
      ).rejects.toThrow('conflicting ownership');
    });

    it('does not replay old starts or phases after a later native settings version while delivering a newly scheduled boundary', async () => {
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      await nativeCompetitionRuntimeService.processCompetition(
        competitionId,
        4000
      );
      await sqlExecutor.execute(
        `UPDATE ${COMPETITIONS_TABLE} SET config_version=2,participation_config=JSON_SET(participation_config,'$.ends_at',7000),voting_config=JSON_SET(voting_config,'$.ends_at',2000) WHERE id=:competitionId`,
        { competitionId }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_CONFIG_VERSIONS_TABLE} (competition_id,version,config,created_by,created_at) VALUES (:competitionId,2,'{}','fixture',6000)`,
        { competitionId }
      );
      await nativeCompetitionRuntimeService.processCompetition(
        competitionId,
        7500
      );
      await nativeCompetitionRuntimeService.processCompetition(
        competitionId,
        7500
      );
      const transitions = await sqlExecutor.execute<{
        semantic_key: string;
        delivered_at: number | null;
      }>(
        `SELECT semantic_key,delivered_at FROM ${COMPETITION_OUTBOX_TABLE} WHERE competition_id=:competitionId AND (semantic_key=:started OR semantic_key LIKE :phase) ORDER BY semantic_key`,
        {
          competitionId,
          started: `${competitionId}:started`,
          phase: `${competitionId}:phase:%`
        }
      );
      expect(transitions).toEqual([
        { semantic_key: `${competitionId}:phase:1:0`, delivered_at: 3000 },
        { semantic_key: `${competitionId}:phase:2:7000`, delivered_at: null },
        { semantic_key: `${competitionId}:started`, delivered_at: 3000 }
      ]);
    });

    it('records historical transition receipts as delivered without acknowledging an existing pending native event', async () => {
      await sqlExecutor.execute(
        `INSERT INTO ${COMPETITION_OUTBOX_TABLE} (id,competition_id,wave_id,semantic_key,event,created_at,next_attempt_at,attempts) VALUES ('existing-native-event',:competitionId,:waveId,:key,'{}',0,0,0)`,
        { competitionId, waveId: wave.id, key: `${competitionId}:started` }
      );
      await transferCompetitionRetirementHistory(sqlExecutor, competitionId);
      expect(
        await sqlExecutor.execute(
          `SELECT id,delivered_at FROM ${COMPETITION_OUTBOX_TABLE} WHERE semantic_key=:key`,
          { key: `${competitionId}:started` }
        )
      ).toEqual([{ id: 'existing-native-event', delivered_at: null }]);
      const phases = await sqlExecutor.execute<{ delivered_at: number }>(
        `SELECT delivered_at FROM ${COMPETITION_OUTBOX_TABLE} WHERE semantic_key LIKE :key`,
        { key: `${competitionId}:phase:%` }
      );
      expect(phases).toHaveLength(1);
      expect(phases[0].delivered_at).toBe(3000);
    });
  }
);
