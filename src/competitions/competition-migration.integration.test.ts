import { withLegacyCompetitionProfileMerge } from './legacy-competition-profile-merge';
import { DropVotingDb } from '@/api/drops/drop-voting.db';
import { migrationCommandConfiguration } from './legacy-competition-configuration';
import { NativeCompetitionReader } from './native-competition.reader';
import { withLegacyCompetitionGetFacade } from './legacy-competition-get-facade';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  COMPETITION_VOTES_TABLE,
  DROPS_PARTS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_MIGRATION_CHANGES_TABLE,
  COMPETITIONS_TABLE,
  DROP_RANK_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  IDENTITIES_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROPS_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { WaveType } from '@/entities/IWave';
import { CompetitionRepository } from './competition.repository';
import {
  legacyCompetitionId,
  legacyCompetitionEntryId
} from './competition-id';
import { CompetitionMigrationService } from './competition-migration.service';
import {
  installMigrationCapture,
  migrationCaptureHealthy
} from './competition-migration-capture';
import {
  executeMigrationCommand,
  parseMigrationOptions
} from './competition-migration.cli';

const wave = aWave(
  {
    type: WaveType.RANK,
    participation_period_start: 1,
    participation_period_end: 1000,
    voting_period_start: 1,
    voting_period_end: 1000,
    next_decision_time: null,
    decisions_strategy: {
      first_decision_time: 900,
      subsequent_decisions: [],
      is_rolling: false
    }
  },
  {
    id: 'migration-fixture-wave',
    name: 'Completed disposable fixture',
    serial_no: 1
  }
);
const id = legacyCompetitionId(wave.id);
const operator = {
  actor: 'fixture-operator',
  reason: 'disposable fixture rehearsal'
};
const drop = {
  id: 'migration-fixture-drop',
  wave_id: wave.id,
  author_id: 'fixture-author',
  created_at: 10,
  updated_at: null,
  title: null,
  parts_count: 1,
  drop_type: 'PARTICIPATORY',
  signature: null,
  hide_link_preview: false
};

async function finishBackfill(service: CompetitionMigrationService) {
  for (let batch = 0; batch < 100; batch++) {
    const status = await service.status(id);
    if (status.migration?.state === 'SHADOWING') return;
    await service.backfill(id, operator, 1);
  }
  throw new Error('Bounded fixture did not finish');
}

describeWithSeed(
  'legacy migration disposable MySQL rehearsal',
  [
    withWaves([wave]),
    withIdentities([
      anIdentity(
        { tdh: 100 },
        {
          profile_id: 'fixture-voter',
          consolidation_key: '0xfixture',
          primary_address: '0xfixture',
          handle: 'fixture-voter'
        }
      ),
      anIdentity(
        { tdh: 100 },
        {
          profile_id: 'fixture-author',
          consolidation_key: '0xtarget',
          primary_address: '0xtarget',
          handle: 'fixture-author'
        }
      )
    ]),
    { table: DROPS_TABLE, rows: [drop] },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: drop.id,
          drop_part_id: 1,
          content: 'original content',
          wave_id: null
        }
      ]
    },
    {
      table: DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [{ wave_id: wave.id, drop_id: drop.id, timestamp: 10, vote: 7 }]
    },
    {
      table: DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          wave_id: wave.id,
          drop_id: drop.id,
          voter_id: 'fixture-voter',
          timestamp: 10,
          vote: 7
        }
      ]
    },
    {
      table: DROP_RANK_TABLE,
      rows: [
        { drop_id: drop.id, wave_id: wave.id, vote: 7, last_increased: 10 }
      ]
    },
    {
      table: DROP_VOTER_STATE_TABLE,
      rows: [
        {
          drop_id: drop.id,
          wave_id: wave.id,
          voter_id: 'fixture-voter',
          votes: 7
        }
      ]
    },
    {
      table: DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
      rows: [
        {
          voter_id: 'fixture-voter',
          drop_id: drop.id,
          wave_id: wave.id,
          credit_spent: 7,
          created_at: 10
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      await new CompetitionRepository().ensureLegacyMappingForWave(wave, {});
      await installMigrationCapture(sqlExecutor);
    });
    it('installs repeatably, captures accepted writes atomically, and never captures rolled-back writes', async () => {
      await installMigrationCapture(sqlExecutor);
      expect(await migrationCaptureHealthy(sqlExecutor, {})).toBe(true);
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await sqlExecutor.execute(
        `update ${DROP_VOTER_STATE_TABLE} set votes=8 where drop_id=:dropId`,
        { dropId: drop.id }
      );
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await sqlExecutor.execute(
            `update ${DROP_VOTER_STATE_TABLE} set votes=9 where drop_id=:dropId`,
            { dropId: drop.id },
            { wrappedConnection: connection }
          );
          throw new Error('simulate interruption');
        })
      ).rejects.toThrow('simulate interruption');
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
      const changes = await sqlExecutor.execute<{
        before_row: Record<string, unknown>;
        after_row: Record<string, unknown> | string;
      }>(
        `select before_row,after_row from ${COMPETITION_MIGRATION_CHANGES_TABLE} where competition_id=:id`,
        { id }
      );
      expect(changes).toHaveLength(1);
      const image =
        typeof changes[0].after_row === 'string'
          ? JSON.parse(changes[0].after_row)
          : changes[0].after_row;
      expect(image.votes).toBe(8);
      await expect(
        sqlExecutor.execute(
          `update ${DROPS_TABLE} set id='moved-drop' where id=:dropId`,
          { dropId: drop.id }
        )
      ).rejects.toThrow('COMPETITION_SOURCE_KEY_MOVE_REQUIRES_REPAIR');
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
    });
    it('resumes bounded stages, preserves entry identity, and prevents readiness without production evidence', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await executeMigrationCommand(
        parseMigrationOptions([
          '--environment',
          'local',
          '--competition',
          id,
          '--action',
          'enroll',
          '--cohort',
          'COMPLETED_INTERNAL',
          '--operator',
          operator.actor,
          '--reason',
          operator.reason,
          '--live'
        ]),
        service
      );
      await service.backfill(id, operator, 1);
      expect((await service.status(id)).migration?.stage).toBe('OUTCOMES');
      await finishBackfill(
        new CompetitionMigrationService(() => sqlExecutor, Date.now, 0)
      );
      const entries = await sqlExecutor.execute<{
        id: string;
        drop_id: string;
      }>(
        `select id,drop_id from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id`,
        { id }
      );
      expect(entries).toEqual([
        { id: legacyCompetitionEntryId(id, drop.id), drop_id: drop.id }
      ]);
      const comparison = await service.compare(id, operator, 1);
      expect(
        comparison.categories
          .filter(
            (category) => category.baselineHash !== category.candidateHash
          )
          .map((category) => category.category)
      ).toEqual([]);
      expect((await service.readiness(id)).failures).toContain(
        'EVIDENCE_nativeRankCompletion'
      );
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: false
      });
      expect(
        (
          await sqlExecutor.oneOrNull<{ storage_mode: string }>(
            `select storage_mode from ${COMPETITIONS_TABLE} where id=:id`,
            { id }
          )
        )?.storage_mode
      ).toBe('LEGACY_ADAPTER');
    });
    it('counts seven full consecutive windows, resets on independent mismatch, and refuses a partial window', async () => {
      let clock = 1000000;
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        (await service.compare(id, operator, 60000)).consecutiveFullWindows
      ).toBe(0);
      for (let i = 1; i <= 7; i++) {
        clock += 60000;
        expect(
          (await service.compare(id, operator, 60000)).consecutiveFullWindows
        ).toBe(i);
      }
      clock += 1;
      expect(
        (await service.compare(id, operator, 60000)).consecutiveFullWindows
      ).toBe(7);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRIES_TABLE} set submitter_id='deliberate-candidate-mismatch' where competition_id=:id`,
        { id }
      );
      const mismatch = await service.compare(id, operator, 60000);
      expect(mismatch.mismatches).toBeGreaterThan(0);
      expect(mismatch.consecutiveFullWindows).toBe(0);
    });
    it('does not count complete windows while transferred votes exceed the live source credit budget', async () => {
      let clock = 1000000;
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh=0 where profile_id='fixture-voter'`
      );
      await service.compare(id, operator, 60000);
      clock += 60000;
      expect(await service.compare(id, operator, 60000)).toMatchObject({
        complete: false,
        consecutiveFullWindows: 0,
        sourceFailures: ['SOURCE_CREDIT_OVERSPENT']
      });
    });
    it('rehearses explicit CLI cutover, native frozen reads, bounded reverse reconciliation and atomic rollback', async () => {
      let clock = 1000000;
      const flags = [
        'FEATURE_NATIVE_COMPETITION_WRITES',
        'FEATURE_NATIVE_COMPETITION_EXECUTION',
        'COMPETITION_LEGACY_GET_FACADE_ENABLED'
      ];
      const saved = flags.map((key) => process.env[key]);
      try {
        for (const key of flags) process.env[key] = 'true';
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          () => clock,
          0
        );
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        const record =
          (await new CompetitionRepository().findCompetitionRecordById(
            id,
            {}
          ))!;
        const configuration = await new NativeCompetitionReader(
          new CompetitionRepository(),
          {},
          true
        ).getCompetition(record, clock);
        expect(() =>
          migrationCommandConfiguration(configuration)
        ).not.toThrow();
        // Disposable evidence demonstrates gate mechanics only; this is not
        // production acceptance and is never written outside the test database.
        await service.recordAcceptance(id, operator, {
          nativeRankCompletion: 'https://example.test/fixture/rank',
          nativeApproveCompletion: 'https://example.test/fixture/approve',
          operationalAcceptance: 'https://example.test/fixture/ops',
          compatibilityAcceptance: 'https://example.test/fixture/get',
          rollbackRehearsal: 'https://example.test/fixture/rollback',
          alertsVerified: 'https://example.test/fixture/alerts',
          productionEvidenceVerifiedBy: operator.actor,
          productionEvidenceVerifiedAt: clock,
          comparisonWindowMs: 60000,
          serviceRevisions: Object.fromEntries(
            [
              'api',
              'waveDecisionExecutionLoop',
              'waveLeaderboardSnapshotterLoop',
              'tdhLoop'
            ].map((name) => [name, 'a'.repeat(40)])
          ),
          apiBaselineP95: 100,
          apiP95: 100,
          apiBudgetP95: 150,
          apiBaselineErrorRate: 0,
          apiErrorRate: 0,
          decisionBudgetP95: 60,
          decisionBudgetP99: 120,
          decisionP95: 10,
          decisionP99: 20,
          incidentWindowStartsAt: clock - 1,
          incidentWindowEndsAt: clock + 3600000
        });
        await service.compare(id, operator, 60000);
        for (let i = 0; i < 7; i++) {
          clock += 60000;
          await service.compare(id, operator, 60000);
        }
        expect((await service.readiness(id)).failures).toEqual([]);
        const args = [
          '--environment',
          'local',
          '--competition',
          id,
          '--action',
          'cutover',
          '--operator',
          operator.actor,
          '--reason',
          operator.reason
        ];
        expect(
          await executeMigrationCommand(parseMigrationOptions(args), service)
        ).toMatchObject({ changed: false, failures: [] });
        expect(
          await executeMigrationCommand(
            parseMigrationOptions([...args, '--live']),
            service
          )
        ).toMatchObject({ changed: true, failures: [] });
        await expect(
          sqlExecutor.execute(
            `update ${DROP_VOTER_STATE_TABLE} set votes=8 where drop_id=:dropId`,
            { dropId: drop.id }
          )
        ).rejects.toThrow('COMPETITION_NATIVE_OWNER_RETRY');
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            const ctx = { connection };
            await withLegacyCompetitionProfileMerge(
              sqlExecutor,
              ['fixture-voter'],
              'fixture-author',
              () =>
                new DropVotingDb(() => sqlExecutor).mergeOnProfileIdChange(
                  { previous_id: 'fixture-voter', new_id: 'fixture-author' },
                  ctx
                ),
              ctx
            );
          }
        );
        expect(
          await sqlExecutor.execute(
            `select voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
            { id }
          )
        ).toEqual([
          { voter_profile_id: 'fixture-author', value: 7, credit_spent: 7 }
        ]);
        expect((await service.verifyNative(id)).failures).toEqual([]);
        await sqlExecutor.execute(
          `update ${COMPETITIONS_TABLE} set title='Native title fixture' where id=:id`,
          { id }
        );
        const nativeView = await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.oneOrNull<{ name: string }>(
            `select name from waves where id=:waveId`,
            { waveId: wave.id }
          )
        );
        expect(nativeView?.name).toBe('Native title fixture');
        expect(await service.rollback(id, operator, true)).toMatchObject({
          changed: false,
          failures: ['REVERSE_RECONCILIATION_INCOMPLETE']
        });
        for (let batch = 0; batch < 100; batch++) {
          if ((await service.status(id)).migration?.reverse_ready) break;
          await service.reverseReconcile(id, operator, 1);
        }
        expect((await service.status(id)).migration?.reverse_ready).toBe(true);
        expect(await service.rollback(id, operator, true)).toMatchObject({
          changed: false,
          failures: []
        });
        expect(await service.rollback(id, operator, false)).toMatchObject({
          changed: true,
          repairRequired: false
        });
        expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
        expect(
          (
            await sqlExecutor.oneOrNull<{ name: string }>(
              `select name from waves where id=:waveId`,
              { waveId: wave.id }
            )
          )?.name
        ).toBe('Native title fixture');
        await service.enroll(id, operator, 'COMPLETED_INTERNAL');
        await finishBackfill(service);
        expect((await service.compare(id, operator, 60000)).mismatches).toBe(0);
        expect((await service.status(id)).migration?.acceptance).toBeNull();
      } finally {
        for (let i = 0; i < flags.length; i++) {
          if (saved[i] === undefined) delete process.env[flags[i]];
          else process.env[flags[i]] = saved[i];
        }
      }
    });
    it('durably records an owned stop when an oversized distribution appears after enrollment', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await service.backfill(id, operator, 25);
      for (let position = 1; position <= 101; position++)
        await sqlExecutor.execute(
          `insert into ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} (wave_id,wave_outcome_position,wave_outcome_distribution_item_position,description,amount) values (:waveId,1,:position,'fixture',null)`,
          { waveId: wave.id, position }
        );
      await expect(
        executeMigrationCommand(
          parseMigrationOptions([
            '--environment',
            'local',
            '--competition',
            id,
            '--action',
            'backfill',
            '--operator',
            operator.actor,
            '--reason',
            operator.reason,
            '--live'
          ]),
          service
        )
      ).rejects.toThrow('OWNED_EXCEPTION');
      const status = await service.status(id);
      expect(status.migration?.exceptions).toContain(
        `MIGRATION_DATA_SHAPE:${operator.actor}`
      );
      expect(status.migration?.stage).toBe('OUTCOMES');
      expect(status.storageMode).toBe('LEGACY_ADAPTER');
    });
    it('captures child edits with a null wave cache, resumes one journal row at a time and detects stored content corruption', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${DROPS_PARTS_TABLE} set content='accepted content edit' where drop_id=:dropId`,
        { dropId: drop.id }
      );
      expect((await service.status(id)).migration?.source_watermark).toBe(1);
      expect(
        (await service.compare(id, operator, 60000)).mismatches
      ).toBeGreaterThan(0);
      await service.catchUp(id, operator, 1);
      await finishBackfill(service);
      expect((await service.compare(id, operator, 60000)).mismatches).toBe(0);
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE} set content=json_set(content,'$.title','corrupt candidate') where competition_id=:id`,
        { id }
      );
      const report = await service.compare(id, operator, 60000);
      expect(
        report.categories.find(
          (item) => item.category === 'native_entry_content'
        )
      ).toEqual(
        expect.objectContaining({
          baselineHash: expect.any(String),
          candidateHash: expect.any(String)
        })
      );
      expect(report.mismatches).toBeGreaterThan(0);
      expect(report.consecutiveFullWindows).toBe(0);
    });
    it('replays both keys when a legacy voter identity changes during capture', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          for (const table of [
            DROP_VOTER_STATE_TABLE,
            DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
            DROP_REAL_VOTER_VOTE_IN_TIME_TABLE
          ]) {
            await sqlExecutor.execute(
              `update ${table} set voter_id='fixture-author' where voter_id='fixture-voter'`,
              {},
              { wrappedConnection: connection }
            );
          }
        }
      );
      for (let batch = 0; batch < 3; batch++)
        await service.catchUp(id, operator, 1);
      await finishBackfill(service);
      expect(
        await sqlExecutor.execute(
          `select voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([
        { voter_profile_id: 'fixture-author', value: 7, credit_spent: 7 }
      ]);
    });
    it('captures a concurrent vote while a partially completed copy resumes, and catches up through its watermark', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await service.backfill(id, operator, 1);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const options = { wrappedConnection: connection };
          await sqlExecutor.execute(
            `update ${DROP_VOTER_STATE_TABLE} set votes=9 where drop_id=:dropId`,
            { dropId: drop.id },
            options
          );
          await sqlExecutor.execute(
            `update ${DROP_RANK_TABLE} set vote=9 where drop_id=:dropId`,
            { dropId: drop.id },
            options
          );
          await sqlExecutor.execute(
            `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (voter_id,drop_id,wave_id,credit_spent,created_at) values ('fixture-voter',:dropId,:waveId,2,11)`,
            { dropId: drop.id, waveId: wave.id },
            options
          );
        }
      );
      await finishBackfill(service);
      expect((await service.status(id)).readiness?.sourceWatermark).toBe(3);
      await service.catchUp(id, operator);
      await finishBackfill(service);
      const status = await service.status(id);
      expect(status.readiness?.sourceWatermark).toBe(
        status.readiness?.appliedWatermark
      );
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      await service.catchUp(id, operator);
      expect((await service.status(id)).migration?.state).toBe('SHADOWING');
    });
  }
);
