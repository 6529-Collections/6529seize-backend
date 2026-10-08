import { withLegacyCompetitionProfileMerge } from './legacy-competition-profile-merge';
import { appFeatures } from '@/app-features';
import { DropVotingDb } from '@/api/drops/drop-voting.db';
import { migrationCommandConfiguration } from './legacy-competition-configuration';
import { NativeCompetitionReader } from './native-competition.reader';
import {
  LEGACY_GET_SOURCE_TABLES,
  withLegacyCompetitionGetFacade
} from './legacy-competition-get-facade';
import {
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_ENTRY_RUNTIME_TABLE,
  COMPETITION_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_ENTRY_CONTENT_VERSIONS_TABLE,
  COMPETITION_VOTES_TABLE,
  DROPS_PARTS_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  COMPETITION_MIGRATION_CHANGES_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
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
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(true);
      await new CompetitionRepository().ensureLegacyMappingForWave(wave, {});
      await installMigrationCapture(sqlExecutor);
    });
    afterEach(() => jest.restoreAllMocks());
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
    it('resumes bounded stages, preserves entry identity, and permits transfer after matching data', async () => {
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
      expect((await service.readiness(id)).failures).toEqual([]);
      expect(await service.cutover(id, operator, true)).toMatchObject({
        changed: false,
        failures: []
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
    it('ranks text-backed positive and negative legacy totals numerically during backfill', async () => {
      const votes = [-5, -2, 12, 9];
      for (let index = 0; index < votes.length; index++) {
        const vote = votes[index];
        const params = {
          dropId: `numeric-migration-drop-${index}`,
          waveId: wave.id,
          vote: String(vote),
          spent: Math.abs(vote),
          timestamp: 20 + index
        };
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
           values (:dropId,:waveId,'fixture-author',:timestamp,1,'PARTICIPATORY',0)`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_PARTS_TABLE} (drop_id,drop_part_id,content) values (:dropId,1,'numeric sorting fixture')`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROP_RANK_TABLE} (drop_id,wave_id,vote,last_increased) values (:dropId,:waveId,:vote,0)`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROP_VOTER_STATE_TABLE} (drop_id,wave_id,voter_id,votes) values (:dropId,:waveId,'fixture-voter',:vote)`,
          params
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_VOTES_CREDIT_SPENDINGS_TABLE} (drop_id,wave_id,voter_id,credit_spent,created_at)
           values (:dropId,:waveId,'fixture-voter',:spent,:timestamp)`,
          params
        );
      }
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        await sqlExecutor.execute(
          `select rating,\`rank\` from ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} where competition_id=:id order by \`rank\``,
          { id }
        )
      ).toEqual([
        { rating: 12, rank: 1 },
        { rating: 9, rank: 2 },
        { rating: 7, rank: 3 },
        { rating: -2, rank: 4 },
        { rating: -5, rank: 5 }
      ]);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });
    it('preserves absent legacy rank rows for unvoted entries at cutover', async () => {
      const unvotedDropId = 'unvoted-migration-drop';
      const zeroDropId = 'zero-migration-drop';
      for (const dropId of [unvotedDropId, zeroDropId]) {
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
         values (:dropId,:waveId,'fixture-author',20,1,'PARTICIPATORY',0)`,
          { dropId, waveId: wave.id }
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_PARTS_TABLE} (drop_id,drop_part_id,content) values (:dropId,1,'unvoted fixture')`,
          { dropId }
        );
      }
      await sqlExecutor.execute(
        `insert into ${DROP_RANK_TABLE} (drop_id,wave_id,vote,last_increased) values (:dropId,:waveId,0,0)`,
        { dropId: zeroDropId, waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      expect(
        await sqlExecutor.execute(
          `select drop_id from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id order by drop_id`,
          { id }
        )
      ).toEqual([
        { drop_id: drop.id },
        { drop_id: unvotedDropId },
        { drop_id: zeroDropId }
      ]);
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select drop_id from ${DROP_RANK_TABLE} where wave_id=:waveId order by drop_id`,
            { waveId: wave.id }
          )
        )
      ).toEqual([{ drop_id: drop.id }, { drop_id: zeroDropId }]);
      // A first negative native vote must be visible even without an increase.
      await sqlExecutor.execute(
        `update ${COMPETITION_ENTRY_RUNTIME_TABLE} set real_time_rating=-2 where entry_id=:entryId`,
        { entryId: legacyCompetitionEntryId(id, unvotedDropId) }
      );
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select vote from ${DROP_RANK_TABLE} where drop_id=:dropId`,
            { dropId: unvotedDropId }
          )
        )
      ).toEqual([{ vote: '-2' }]);
    });
    it('rebuilds derived shadow data on retry after a failed independent comparison', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `update ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} set \`rank\`=9 where competition_id=:id`,
        { id }
      );
      expect((await service.compare(id, operator, 1)).mismatches).toBe(1);
      expect((await service.status(id)).storageMode).toBe('LEGACY_ADAPTER');
      const resumed = await service.resumeMigration(id, operator);
      expect(resumed.migration).toMatchObject({
        state: 'BACKFILLING',
        stage: 'ENTRIES',
        stage_offset: 0,
        source_watermark: 0,
        applied_watermark: 0,
        completed_stages: ['CONFIGURATION', 'OUTCOMES']
      });
      await finishBackfill(service);
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
      expect(await service.cutover(id, operator, true)).toMatchObject({
        failures: []
      });
    });
    it('preserves historical time locks below the current creation minimum', async () => {
      await sqlExecutor.execute(
        'update waves set time_lock_ms=240000 where id=:waveId',
        { waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        (await service.compare(id, operator, 1)).categories
          .filter(
            (category) => category.baselineHash !== category.candidateHash
          )
          .map((category) => category.category)
      ).toEqual([]);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
      const repository = new CompetitionRepository();
      const raw = await repository.findCompetitionRecordById(id, {});
      if (!raw) throw new Error('Missing migrated competition');
      const record = repository.parseCompetitionRecord(raw);
      const competition = await new NativeCompetitionReader(
        new CompetitionRepository(),
        {}
      ).getCompetition(record, Date.now());
      expect(competition.decisions.time_lock_ms).toBe(240000);
      expect(
        migrationCommandConfiguration(competition).rules.time_lock_ms
      ).toBe(240000);
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select drop_id from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id=:waveId`,
            { waveId: wave.id }
          )
        )
      ).toEqual([]);
      await sqlExecutor.execute(
        `update ${COMPETITION_LEADERBOARD_ENTRIES_TABLE} set updated_at=100 where competition_id=:id`,
        { id }
      );
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select drop_id from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id=:waveId`,
            { waveId: wave.id }
          )
        )
      ).toEqual([{ drop_id: drop.id }]);
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
        const siblingId = '10000000-0000-4000-8000-000000000099';
        await sqlExecutor.execute(
          `insert into ${COMPETITIONS_TABLE} (id,wave_id,legacy_wave_id,storage_mode,execution_mode,type,lifecycle,title,
           participation_config,voting_config,decision_config,winner_config,outcome_config,config_version,created_at,updated_at,published_at)
           select :siblingId,wave_id,null,'NATIVE','ACTIVE',type,'PUBLISHED','Sibling native competition',
           participation_config,voting_config,decision_config,winner_config,outcome_config,1,:clock,:clock,:clock
           from ${COMPETITIONS_TABLE} where id=:id`,
          { id, siblingId, clock }
        );
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,title,parts_count,drop_type,hide_link_preview)
           values ('sibling-native-drop',:waveId,'fixture-author',10,'Sibling content',1,'COMPETITION',0),
           ('shared-chat-drop',:waveId,'fixture-author',10,'Shared chat',1,'CHAT',0)`,
          { waveId: wave.id }
        );
        await sqlExecutor.execute(
          `insert into ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
           values ('20000000-0000-4000-8000-000000000099',:siblingId,:waveId,'sibling-native-drop','fixture-author','ACTIVE',1,10)`,
          { siblingId, waveId: wave.id }
        );
        const sharedSource = await sqlExecutor.execute(
          `select * from ${DROPS_TABLE} where id in ('sibling-native-drop','shared-chat-drop') order by id`
        );
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
          await sqlExecutor.execute(
            `select * from ${DROPS_TABLE} where id in ('sibling-native-drop','shared-chat-drop') order by id`
          )
        ).toEqual(sharedSource);
        expect(
          await withLegacyCompetitionGetFacade(() =>
            sqlExecutor.oneOrNull(
              `select drop_type from ${DROPS_TABLE} where id='sibling-native-drop'`
            )
          )
        ).toEqual({ drop_type: 'CHAT' });
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
        const reenrolled = await service.status(id);
        expect(reenrolled.migration?.acceptance).toBeNull();
        expect(reenrolled.migration?.consecutive_full_windows).toBe(0);
      } finally {
        for (let i = 0; i < flags.length; i++) {
          if (saved[i] === undefined) delete process.env[flags[i]];
          else process.env[flags[i]] = saved[i];
        }
      }
    });
    it('retains native ownership and immutable drop types when reverse materialization encounters a native-created primary entry', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      await sqlExecutor.execute(
        `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview)
         values ('native-created-primary',:waveId,'fixture-author',10,1,'COMPETITION',0)`,
        { waveId: wave.id }
      );
      await sqlExecutor.execute(
        `insert into ${COMPETITION_ENTRIES_TABLE} (id,competition_id,wave_id,drop_id,submitter_id,status,config_version,submitted_at)
         values ('20000000-0000-4000-8000-000000000098',:id,:waveId,'native-created-primary','fixture-author','ACTIVE',1,10)`,
        { id, waveId: wave.id }
      );
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set storage_mode='NATIVE' where id=:id`,
        { id }
      );
      // Isolate reverse refusal; the full cutover gate is exercised above.
      await sqlExecutor.execute(
        `update ${COMPETITION_MIGRATIONS_TABLE} set state='NATIVE',reverse_checkpoint=:checkpoint where competition_id=:id`,
        {
          id,
          checkpoint: JSON.stringify({
            index: LEGACY_GET_SOURCE_TABLES.indexOf(DROPS_TABLE),
            phase: 'COPY',
            cursor: null
          })
        }
      );
      await expect(
        executeMigrationCommand(
          parseMigrationOptions([
            '--environment',
            'local',
            '--competition',
            id,
            '--action',
            'reverse-reconcile',
            '--operator',
            operator.actor,
            '--reason',
            operator.reason,
            '--live'
          ]),
          service
        )
      ).rejects.toThrow(
        'OWNED_EXCEPTION: reverse reconciliation cannot change native-created primary drop types'
      );
      const guarded = await service.status(id);
      expect(guarded.storageMode).toBe('NATIVE');
      expect(guarded.migration?.state).toBe('ROLLBACK_REQUIRED');
      expect(guarded.migration?.reverse_ready).toBe(false);
      expect(guarded.migration?.exceptions).toContain(
        `NATIVE_MIGRATION_DATA_SHAPE:${operator.actor}`
      );
      expect(
        await sqlExecutor.oneOrNull(
          `select drop_type from ${DROPS_TABLE} where id='native-created-primary'`
        )
      ).toEqual({ drop_type: 'COMPETITION' });
      expect(
        (await new CompetitionRepository().findCompetitionRecordById(id, {}))
          ?.storage_mode
      ).toBe('NATIVE');
    });
    it('copies a valid outcome distribution spanning multiple pages without a size stop', async () => {
      await sqlExecutor.execute(
        `insert into ${WAVE_OUTCOMES_TABLE} (wave_id,wave_outcome_position,type,description)
         values (:waveId,1,'MANUAL','Paginated migration outcome')`,
        { waveId: wave.id }
      );
      const rows = Array.from(
        { length: 1001 },
        (_, index) => `(:waveId,1,${index + 1},'fixture',null)`
      ).join(',');
      await sqlExecutor.execute(
        `insert into ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE}
         (wave_id,wave_outcome_position,wave_outcome_distribution_item_position,description,amount) values ${rows}`,
        { waveId: wave.id }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'COMPLETED_INTERNAL');
      await finishBackfill(service);
      expect(
        await sqlExecutor.oneOrNull<{ count: number }>(
          `select count(*) as count from ${COMPETITION_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual({ count: 1001 });
      expect((await service.compare(id, operator, 1)).mismatches).toBe(0);
    });

    it('retains oversized orphan distribution history without an artificial size stop', async () => {
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
      await service.backfill(id, operator, 100);
      const status = await service.status(id);
      expect(status.storageMode).toBe('LEGACY_ADAPTER');
      expect(status.migration?.exceptions).toEqual([]);
      expect(
        await sqlExecutor.oneOrNull<{ count: number }>(
          `select count(*) as count from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id=:waveId`,
          { waveId: wave.id }
        )
      ).toEqual({ count: 101 });
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
