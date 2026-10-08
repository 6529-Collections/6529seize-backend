import { revokeTdhBasedDropWavesOverVotes } from '@/drops/participation-drops-over-vote-revocation';
import { userNotifier } from '@/notifications/user.notifier';
import { appFeatures } from '@/app-features';
import * as claims from '@/waves/claims-builder-publisher';
import * as pushes from '@/api/push-notifications/push-notifications.service';
import {
  COMPETITION_DECISIONS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  COMPETITION_VOTES_TABLE,
  IDENTITIES_TABLE,
  COMPETITION_DECISION_WINNERS_TABLE,
  COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE,
  COMPETITION_OUTBOX_TABLE,
  COMPETITION_WINNER_VOTES_TABLE,
  DROPS_TABLE,
  DROP_RANK_TABLE,
  DROP_VOTER_STATE_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
  WAVE_LEADERBOARD_ENTRIES_TABLE,
  WAVE_OUTCOMES_TABLE,
  WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
  WAVES_DECISIONS_TABLE,
  WAVES_DECISION_WINNER_DROPS_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  approveMigrationFixture,
  migrationFixtureAcceptance,
  finishMigrationFixture,
  migrationFixtureOperator as operator
} from '@/tests/fixtures/competition-migration.fixture';
import { CompetitionRepository } from './competition.repository';
import { CompetitionMigrationService } from './competition-migration.service';
import { installMigrationCapture } from './competition-migration-capture';
import { legacyCompetitionId } from './competition-id';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionCreditService } from './competition-credit.service';
import { competitionExecutionRouter } from './competition-execution.router';
import {
  deliverLegacyExecutionEffects,
  recordLegacyExecutionEffects
} from './legacy-competition-execution-effects';
import { withLegacyCompetitionGetFacade } from './legacy-competition-get-facade';
import {
  reconcileAcceptedLegacyPauses,
  withLegacyPrimaryMutation
} from './legacy-competition-mutation';
import { competitionCommandRepository } from './competition-command.repository';
import { LEGACY_INDEFINITE_PAUSE_END } from './legacy-competition-settings.repository';
import { voteForMigratedLegacyEntry } from './legacy-competition-vote.service';
import { CompetitionMigrationBackfill } from './competition-migration-backfill';
import { migrateWave } from './wave-migration';

const active = aWave(
  {
    type: WaveType.RANK,
    participation_period_start: 1,
    voting_period_start: 1,
    forbid_negative_votes: true,
    time_lock_ms: 300000,
    next_decision_time: 3000000,
    decisions_strategy: {
      first_decision_time: 3000000,
      subsequent_decisions: [],
      is_rolling: false
    }
  },
  {
    id: 'migration-active',
    name: 'Disposable active competition',
    serial_no: 1
  }
);
const completed = aWave(
  {
    type: WaveType.RANK,
    participation_period_start: 1,
    participation_period_end: 2,
    voting_period_start: 1,
    voting_period_end: 2,
    decisions_strategy: {
      first_decision_time: 1,
      subsequent_decisions: [],
      is_rolling: false
    }
  },
  { id: 'migration-prior', name: 'Disposable completed cohort', serial_no: 2 }
);
const id = legacyCompetitionId(active.id),
  prior = legacyCompetitionId(completed.id),
  dropId = 'migration-active-drop';
const secondCompleted = {
  ...completed,
  id: 'migration-second-completed',
  name: 'Second completed pilot',
  serial_no: 3
};

describeWithSeed(
  'transferred legacy execution and publication fences',
  [
    withWaves([active, completed, secondCompleted]),
    withIdentities([
      anIdentity(
        { tdh: 100 },
        {
          profile_id: 'migration-voter',
          consolidation_key: '0xfixture',
          primary_address: '0xfixture',
          handle: 'migration-voter'
        }
      )
    ]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: dropId,
          wave_id: active.id,
          author_id: 'migration-author',
          created_at: 10,
          updated_at: null,
          title: null,
          parts_count: 1,
          drop_type: 'PARTICIPATORY',
          signature: null,
          hide_link_preview: false
        }
      ]
    },
    {
      table: DROP_RANK_TABLE,
      rows: [
        { drop_id: dropId, wave_id: active.id, vote: 7, last_increased: 1000 }
      ]
    },
    {
      table: DROP_VOTER_STATE_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: active.id,
          voter_id: 'migration-voter',
          votes: 7
        }
      ]
    },
    {
      table: DROPS_VOTES_CREDIT_SPENDINGS_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: active.id,
          voter_id: 'migration-voter',
          credit_spent: 7,
          created_at: 1000
        }
      ]
    },
    {
      table: DROP_REAL_VOTE_IN_TIME_TABLE,
      rows: [{ drop_id: dropId, wave_id: active.id, timestamp: 1000, vote: 7 }]
    },
    {
      table: DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: active.id,
          voter_id: 'migration-voter',
          timestamp: 1000,
          vote: 7
        }
      ]
    },
    {
      table: WAVE_LEADERBOARD_ENTRIES_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: active.id,
          timestamp: 10000,
          vote: 7,
          vote_on_decision_time: 7,
          over_threshold_since_ms: 2000
        }
      ]
    },
    {
      table: WAVE_OUTCOMES_TABLE,
      rows: [
        {
          wave_id: active.id,
          wave_outcome_position: 1,
          type: 'MANUAL',
          subtype: null,
          description: 'Fixture winner',
          credit: null,
          rep_category: null,
          amount: null
        }
      ]
    },
    {
      table: WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE,
      rows: [
        {
          wave_id: active.id,
          wave_outcome_position: 1,
          wave_outcome_distribution_item_position: 1,
          description: 'First',
          amount: null
        }
      ]
    },
    {
      table: WAVES_DECISION_PAUSES_TABLE,
      rows: [
        {
          wave_id: active.id,
          start_time: 0,
          end_time: 2000000,
          reason: 'Initial review'
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
      const repository = new CompetitionRepository();
      await repository.ensureLegacyMappingForWave(active, {});
      await repository.ensureLegacyMappingForWave(completed, {});
      await repository.ensureLegacyMappingForWave(secondCompleted, {});
      await installMigrationCapture(sqlExecutor);
    });
    afterEach(() => jest.restoreAllMocks());

    it('preserves nullable wave metadata, retained chat snapshots, orphaned outcomes and historical winners', async () => {
      const clock = { value: 10000 };
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set updated_at=null where id=:waveId`,
        { waveId: active.id }
      );
      for (const [suffix, type] of [
        ['retained-chat', 'CHAT'],
        ['historical-winner-1000', 'WINNER'],
        ['historical-winner-2000', 'WINNER']
      ])
        await sqlExecutor.execute(
          `insert into ${DROPS_TABLE} (id,wave_id,author_id,created_at,parts_count,drop_type,hide_link_preview) values(:dropId,:waveId,'migration-author',10,1,:type,false)`,
          { dropId: suffix, waveId: active.id, type }
        );
      await sqlExecutor.execute(
        `insert into ${DROP_RANK_TABLE} (drop_id,wave_id,vote,last_increased) values('historical-winner-1000',:waveId,-26,0)`,
        { waveId: active.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVE_LEADERBOARD_ENTRIES_TABLE} (drop_id,wave_id,timestamp,vote,vote_on_decision_time,over_threshold_since_ms) values('retained-chat',:waveId,10,0,0,null)`,
        { waveId: active.id }
      );
      await sqlExecutor.execute(
        `insert into ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} (wave_id,wave_outcome_position,wave_outcome_distribution_item_position,description,amount) values(:waveId,99,1,'Retained item',1)`,
        { waveId: active.id }
      );
      for (const time of [1000, 2000]) {
        await sqlExecutor.execute(
          `insert into ${WAVES_DECISIONS_TABLE} (wave_id,decision_time) values(:waveId,:time)`,
          { waveId: active.id, time }
        );
        await sqlExecutor.execute(
          `insert into ${WAVES_DECISION_WINNER_DROPS_TABLE} (wave_id,decision_time,drop_id,ranking,final_vote,prizes) values(:waveId,:time,:dropId,1,7,'[]')`,
          { waveId: active.id, time, dropId: `historical-winner-${time}` }
        );
      }
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'local'
      );
      const result = await migrateWave(
        {
          waveId: active.id,
          environment: 'local',
          operator,
          dryRun: false,
          batch: 1,
          timeoutMs: 60000
        },
        service,
        {
          now: () => clock.value,
          wait: async (ms) => {
            clock.value += ms;
          },
          progress: () => undefined
        }
      );
      expect(result.status.storageMode).toBe('NATIVE');
      expect((await service.verifyNative(id)).failures).toEqual([]);
      const query = (sql: string) =>
        withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(sql, { waveId: active.id })
        );
      expect(
        await query(`select updated_at from ${WAVES_TABLE} where id=:waveId`)
      ).toEqual([{ updated_at: null }]);
      expect(
        await query(
          `select ranking,decision_time from ${WAVES_DECISION_WINNER_DROPS_TABLE} where wave_id=:waveId order by decision_time`
        )
      ).toEqual([
        { ranking: 1, decision_time: 1000 },
        { ranking: 1, decision_time: 2000 }
      ]);
      expect(
        await query(
          `select drop_id,vote,last_increased from ${DROP_RANK_TABLE} where wave_id=:waveId and drop_id like 'historical-winner-%' order by drop_id`
        )
      ).toEqual([
        { drop_id: 'historical-winner-1000', vote: '-26', last_increased: 0 }
      ]);
      expect(
        await query(
          `select drop_id from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id=:waveId and drop_id='retained-chat'`
        )
      ).toEqual([{ drop_id: 'retained-chat' }]);
      expect(
        await query(
          `select amount from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id=:waveId and wave_outcome_position=99`
        )
      ).toEqual([{ amount: 1 }]);
    });

    it('preserves pause reasons and indefinite pauses across migration and both command paths', async () => {
      const clock = { value: 10000 };
      await sqlExecutor.execute(
        `update ${WAVES_DECISION_PAUSES_TABLE} set end_time=:end where wave_id=:waveId`,
        { waveId: active.id, end: LEGACY_INDEFINITE_PAUSE_END }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'local'
      );
      const result = await migrateWave(
        {
          waveId: active.id,
          environment: 'local',
          operator,
          dryRun: false,
          batch: 1,
          timeoutMs: 60000
        },
        service,
        {
          now: () => clock.value,
          wait: async (ms) => {
            clock.value += ms;
          },
          progress: () => undefined
        }
      );
      expect(result.status.storageMode).toBe('NATIVE');
      const pauses = () =>
        new CompetitionRepository().listNativePauses(
          id,
          { offset: 0, limit: 20, direction: 'ASC' },
          {}
        );
      expect((await pauses()).data).toMatchObject([
        { end_time: null, reason: 'Initial review' }
      ]);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        withLegacyPrimaryMutation(active.id, { connection }, async (owner) => {
          if (!owner) throw new Error('Expected native primary');
          await sqlExecutor.execute(
            `update ${WAVES_DECISION_PAUSES_TABLE} set reason='Updated review' where wave_id=:waveId`,
            { waveId: active.id },
            { wrappedConnection: connection }
          );
          await reconcileAcceptedLegacyPauses(owner, { connection });
        })
      );
      expect((await pauses()).data[0].reason).toBe('Updated review');
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctx = { connection };
          await competitionCommandRepository.resume(id, clock.value, ctx);
          await competitionCommandRepository.pause(
            id,
            clock.value + 1,
            null,
            'Native review',
            ctx
          );
        }
      );
      expect((await pauses()).data).toMatchObject([
        { end_time: clock.value, reason: 'Updated review' },
        { end_time: null, reason: 'Native review' }
      ]);
      expect(
        await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.execute(
            `select end_time,reason from ${WAVES_DECISION_PAUSES_TABLE} where wave_id=:waveId order by start_time`,
            { waveId: active.id }
          )
        )
      ).toEqual([
        { end_time: clock.value, reason: 'Updated review' },
        { end_time: LEGACY_INDEFINITE_PAUSE_END, reason: 'Native review' }
      ]);
      expect((await service.verifyNative(id)).failures).toEqual([]);
    });

    it.each(['WAVE', 'DROP'])(
      'automates an active negative-vote %s migration locally, preserves sign edits and safely reduces credit',
      async (scope) => {
        const clock = { value: 10000 };
        await sqlExecutor.execute(
          `update ${WAVES_TABLE} set forbid_negative_votes=false,voting_credit_scope=:scope where id=:waveId`,
          { scope, waveId: active.id }
        );
        for (const [table, field] of [
          [DROP_VOTER_STATE_TABLE, 'votes'],
          [DROP_RANK_TABLE, 'vote'],
          [DROP_REAL_VOTE_IN_TIME_TABLE, 'vote'],
          [DROP_REAL_VOTER_VOTE_IN_TIME_TABLE, 'vote'],
          [WAVE_LEADERBOARD_ENTRIES_TABLE, 'vote']
        ])
          await sqlExecutor.execute(
            `update ${table} set ${field}=-7 where wave_id=:waveId`,
            { waveId: active.id }
          );
        await sqlExecutor.execute(
          `update ${WAVE_LEADERBOARD_ENTRIES_TABLE} set vote_on_decision_time=-7 where wave_id=:waveId`,
          { waveId: active.id }
        );
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          () => clock.value,
          0,
          'local'
        );
        if (scope === 'WAVE') {
          await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
          await sqlExecutor.execute(
            `update ${COMPETITION_MIGRATIONS_TABLE} set exceptions=:exceptions where competition_id=:id`,
            {
              id,
              exceptions: JSON.stringify([
                'NEGATIVE_CREDIT_REVOCATION_ADAPTER:old-operator'
              ])
            }
          );
        }
        expect((await service.inspectWave(active.id)).failures).toEqual([]);
        const result = await migrateWave(
          {
            waveId: active.id,
            environment: 'local',
            operator,
            dryRun: false,
            batch: 1,
            timeoutMs: 60000
          },
          service,
          {
            now: () => clock.value,
            wait: async (ms) => {
              clock.value += ms;
            },
            progress: () => undefined
          }
        );
        expect(result.status.storageMode).toBe('NATIVE');
        expect(result.status.migration?.acceptance).toBeNull();
        expect((await service.status(prior)).storageMode).toBe(
          'LEGACY_ADAPTER'
        );
        jest
          .spyOn(userNotifier, 'notifyOfDropVote')
          .mockResolvedValue(undefined);
        jest.spyOn(Date, 'now').mockImplementation(() => clock.value);
        const replace = (votes: number) =>
          sqlExecutor.executeNativeQueriesInTransaction(
            (connection) =>
              withLegacyPrimaryMutation(active.id, { connection }, (owner) => {
                if (!owner) throw new Error('Expected native primary');
                return voteForMigratedLegacyEntry(
                  owner,
                  {
                    wave_id: active.id,
                    drop_id: dropId,
                    voter_id: 'migration-voter',
                    votes,
                    proxy_id: null
                  },
                  { connection }
                );
              }),
            { isolationLevel: 'READ COMMITTED' }
          );
        expect(await replace(-9)).toBe(true);
        expect(await replace(-9)).toBe(false);
        expect(await replace(9)).toBe(true);
        expect(await replace(-7)).toBe(true);
        await sqlExecutor.execute(
          `update ${IDENTITIES_TABLE} set tdh=3 where profile_id='migration-voter'`
        );
        await sqlExecutor.executeNativeQueriesInTransaction(
          (connection) => revokeTdhBasedDropWavesOverVotes(connection),
          { isolationLevel: 'READ COMMITTED' }
        );
        expect(
          await sqlExecutor.execute(
            `select value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
            { id }
          )
        ).toEqual([{ value: -3, credit_spent: 3 }]);
        expect(
          await sqlExecutor.execute(
            `select votes from ${DROP_VOTER_STATE_TABLE} where wave_id=:waveId`,
            { waveId: active.id }
          )
        ).toEqual([{ votes: -3 }]);
        expect((await service.verifyNative(id)).failures).toEqual([]);
        const repeated = await migrateWave(
          {
            waveId: active.id,
            environment: 'local',
            operator,
            dryRun: false,
            batch: 1,
            timeoutMs: 60000
          },
          service,
          {
            now: () => clock.value,
            wait: async () => undefined,
            progress: () => undefined
          }
        );
        expect(repeated.status.storageMode).toBe('NATIVE');
        expect(
          await sqlExecutor.execute(
            `select value from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
            { id }
          )
        ).toEqual([{ value: -3 }]);
      },
      60000
    );

    it('migrates completed waves with no shared acceptance or timed sampling', async () => {
      const clock = { value: 10000 };
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'production'
      );
      for (const wave of [completed, secondCompleted]) {
        const migrated = await migrateWave(
          {
            waveId: wave.id,
            environment: 'production',
            operator,
            dryRun: false,
            batch: 25,
            timeoutMs: 1800000
          },
          service,
          {
            now: () => clock.value,
            wait: async (ms) => {
              clock.value += ms;
            },
            progress: () => undefined
          }
        );
        expect(migrated.status.storageMode).toBe('NATIVE');
        expect(migrated.status.migration?.acceptance).toBeNull();
        expect(clock.value).toBe(10000);
      }
    });

    it('does not let a historical rollout review invalidate a matching data comparison', async () => {
      const clock = { value: 10000 };
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'production'
      );
      await service.enroll(prior, operator, 'COMPLETED_ORDINARY');
      await finishMigrationFixture(service, prior);
      await service.compare(prior, operator, 1);
      expect((await service.readiness(prior)).failures).toEqual([]);
      await service.recordEnvironmentAcceptance(
        operator,
        migrationFixtureAcceptance(clock.value)
      );
      expect((await service.readiness(prior)).failures).toEqual([]);
      expect(await service.cutover(prior, operator, false)).toMatchObject({
        changed: true,
        failures: []
      });
    });

    it.each(['RANK', 'APPROVE'] as const)(
      'preserves weighted %s history, pauses, single-engine ownership and permanent winner reads',
      async (type) => {
        if (type === 'APPROVE')
          await sqlExecutor.execute(
            `update ${WAVES_TABLE} set type='APPROVE',decisions_strategy=null,next_decision_time=null,winning_min_threshold=5,winning_threshold_min_duration_ms=1000,max_winners=1 where id=:waveId`,
            { waveId: active.id }
          );
        const clock = { value: 10000 };
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          () => clock.value,
          0
        );
        await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
        await finishMigrationFixture(service, id);
        await approveMigrationFixture(service, id, clock);
        // An active wave can be the first migration in this environment.
        expect(await service.cutover(id, operator, false)).toMatchObject({
          changed: true,
          failures: []
        });
        expect(
          await competitionExecutionRouter.shouldUseLegacyWaveExecution(
            active.id,
            {}
          )
        ).toBe(false);
        const runtime = new NativeCompetitionRuntimeService(
          new NativeCompetitionRuntimeRepository(() => sqlExecutor),
          competitionCreditService,
          competitionExecutionRouter,
          appFeatures
        );
        await runtime.processCompetition(id, clock.value);
        const decisionCount = async () =>
          Number(
            (
              await sqlExecutor.oneOrNull<{ count: number }>(
                `select count(*) as count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:id`,
                { id }
              )
            )?.count
          );
        expect(await decisionCount()).toBe(0);
        const now = jest.spyOn(Date, 'now').mockReturnValue(clock.value);
        const replace = (votes: number) =>
          sqlExecutor.executeNativeQueriesInTransaction(
            (connection) =>
              withLegacyPrimaryMutation(active.id, { connection }, (owner) => {
                if (!owner) throw new Error('Expected native primary');
                return voteForMigratedLegacyEntry(
                  owner,
                  {
                    wave_id: active.id,
                    drop_id: dropId,
                    voter_id: 'migration-voter',
                    votes,
                    proxy_id: null
                  },
                  { connection }
                );
              }),
            { isolationLevel: 'READ COMMITTED' }
          );
        expect(await replace(9)).toBe(true);
        expect(await replace(9)).toBe(false);
        expect(await replace(7)).toBe(true);
        expect(await replace(7)).toBe(false);
        await sqlExecutor.execute(
          `update ${COMPETITIONS_TABLE} set voting_config=json_set(voting_config,'$.signature_required',true) where id=:id`,
          { id }
        );
        await expect(replace(9)).rejects.toThrow('requires a signed vote');
        await expect(replace(7)).rejects.toThrow('requires a signed vote');
        expect(
          await sqlExecutor.execute(
            `select value from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
            { id }
          )
        ).toEqual([{ value: 7 }]);
        await sqlExecutor.execute(
          `update ${COMPETITIONS_TABLE} set voting_config=json_set(voting_config,'$.signature_required',false) where id=:id`,
          { id }
        );
        now.mockRestore();
        expect((await service.status(id)).migration?.source_watermark).toBe(0);
        clock.value = type === 'RANK' ? 3000001 : 2000001;
        await runtime.processCompetition(id, clock.value);
        expect(await decisionCount()).toBe(1);
        expect(
          (
            await sqlExecutor.oneOrNull<{ final_rating: number }>(
              `select final_rating from ${COMPETITION_DECISION_WINNERS_TABLE} where competition_id=:id`,
              { id }
            )
          )?.final_rating
        ).toBe(7);
        expect(
          (
            await sqlExecutor.oneOrNull<{ value: number }>(
              `select value from ${COMPETITION_WINNER_VOTES_TABLE} where competition_id=:id`,
              { id }
            )
          )?.value
        ).toBe(7);
        const events = await sqlExecutor.execute<{ event_type: string }>(
          `select json_unquote(json_extract(event,'$.event_type')) as event_type from ${COMPETITION_OUTBOX_TABLE} where competition_id=:id`,
          { id }
        );
        expect(events.map((event) => event.event_type)).not.toContain(
          'COMPETITION_STARTED'
        );
        const publicDrop = await withLegacyCompetitionGetFacade(() =>
          sqlExecutor.oneOrNull<{ drop_type: string }>(
            `select drop_type from ${DROPS_TABLE} where id=:dropId`,
            { dropId }
          )
        );
        expect(publicDrop?.drop_type).toBe('WINNER');
        await runtime.processCompetition(id, clock.value + 1);
        expect(await decisionCount()).toBe(1);
        expect(await service.rollback(id, operator, false)).toMatchObject({
          changed: false,
          repairRequired: true
        });
        expect((await service.status(id)).storageMode).toBe('NATIVE');
        await expect(
          sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
            const record =
              await new CompetitionRepository().findCompetitionRecordById(id, {
                connection
              });
            if (!record) throw new Error('Expected transferred primary');
            await new CompetitionMigrationBackfill(sqlExecutor).entry(
              record,
              dropId,
              { connection }
            );
          })
        ).rejects.toThrow('native entry state cannot be reset');
      },
      60000
    );

    it('reconciles a migrated voter credit reduction through system writes and mirrors the accepted result', async () => {
      const clock = { value: 10000 };
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0
      );
      await service.enroll(prior, operator, 'COMPLETED_INTERNAL');
      await finishMigrationFixture(service, prior);
      await approveMigrationFixture(service, prior, clock);
      expect(await service.cutover(prior, operator, false)).toMatchObject({
        changed: true
      });
      await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
      await finishMigrationFixture(service, id);
      await approveMigrationFixture(service, id, clock);
      expect(await service.cutover(id, operator, false)).toMatchObject({
        changed: true
      });
      jest.spyOn(userNotifier, 'notifyOfDropVote').mockResolvedValue(undefined);
      await sqlExecutor.execute(
        `update ${IDENTITIES_TABLE} set tdh=3 where profile_id='migration-voter'`
      );
      await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) => revokeTdhBasedDropWavesOverVotes(connection),
        { isolationLevel: 'READ COMMITTED' }
      );
      expect(
        await sqlExecutor.execute(
          `select value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([{ value: 3, credit_spent: 3 }]);
      expect(
        await sqlExecutor.execute(
          `select votes from ${DROP_VOTER_STATE_TABLE} where wave_id=:waveId`,
          { waveId: active.id }
        )
      ).toEqual([{ votes: 3 }]);
      expect((await service.status(id)).migration?.source_watermark).toBe(0);
      expect(userNotifier.notifyOfDropVote).toHaveBeenCalledTimes(1);
    });
    it('retains a stable pending publication receipt across queue failure and blocks cutover until acknowledged', async () => {
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        Date.now,
        0
      );
      await service.enroll(id, operator, 'ACTIVE_LOW_VOLUME');
      const record = async () =>
        sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          recordLegacyExecutionEffects(
            active.id,
            1000,
            { claimDropId: dropId, pushIds: [12], dirtyWaveIds: [] },
            { connection }
          )
        );
      const effectId = await record();
      expect(await record()).toBe(effectId);
      expect((await service.status(id)).readiness?.pendingEffects).toBe(1);
      const claim = jest
        .spyOn(claims, 'enqueueClaimBuild')
        .mockResolvedValue(undefined);
      const push = jest
        .spyOn(pushes, 'sendIdentityPushNotificationsStrict')
        .mockRejectedValueOnce(new Error('simulated queue interruption'))
        .mockResolvedValue(undefined);
      await expect(deliverLegacyExecutionEffects(effectId!)).rejects.toThrow(
        'simulated queue interruption'
      );
      expect((await service.status(id)).readiness?.pendingEffects).toBe(1);
      await deliverLegacyExecutionEffects(effectId!);
      await deliverLegacyExecutionEffects(effectId!);
      expect(claim.mock.calls).toEqual([[dropId], [dropId]]);
      expect(push.mock.calls).toEqual([[[12]], [[12]]]);
      expect((await service.status(id)).readiness?.pendingEffects).toBe(0);
      expect(
        (
          await sqlExecutor.oneOrNull<{ attempts: number }>(
            `select attempts from ${COMPETITION_LEGACY_EXECUTION_EFFECTS_TABLE} where id=:id`,
            { id: effectId }
          )
        )?.attempts
      ).toBe(2);
    });
  }
);
