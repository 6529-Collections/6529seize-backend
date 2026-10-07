import { revokeTdhBasedDropWavesOverVotes } from '@/drops/participation-drops-over-vote-revocation';
import { userNotifier } from '@/notifications/user.notifier';
import { appFeatures } from '@/app-features';
import * as claims from '@/waves/claims-builder-publisher';
import * as pushes from '@/api/push-notifications/push-notifications.service';
import {
  COMPETITION_DECISIONS_TABLE,
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
import { withLegacyPrimaryMutation } from './legacy-competition-mutation';
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
      rows: [{ wave_id: active.id, start_time: 0, end_time: 2000000 }]
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
          `select drop_id from ${WAVE_LEADERBOARD_ENTRIES_TABLE} where wave_id=:waveId and drop_id='retained-chat'`
        )
      ).toEqual([{ drop_id: 'retained-chat' }]);
      expect(
        await query(
          `select amount from ${WAVE_OUTCOME_DISTRIBUTION_ITEMS_TABLE} where wave_id=:waveId and wave_outcome_position=99`
        )
      ).toEqual([{ amount: 1 }]);
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

    it('reuses one production rollout acceptance for multiple waves and isolates staging reviews', async () => {
      const clock = { value: 10000 };
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'production'
      );
      const acceptance = migrationFixtureAcceptance(clock.value);
      await service.recordEnvironmentAcceptance(operator, acceptance);
      const staging = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'staging'
      );
      await staging.recordEnvironmentAcceptance(operator, {
        ...acceptance,
        nativeRankCompletion: 'https://example.test/staging/rank'
      });
      for (const wave of [completed, secondCompleted]) {
        const competition = legacyCompetitionId(wave.id);
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
        expect(migrated.status.migration?.consecutive_full_windows).toBe(7);
        expect(
          (await service.status(competition)).readiness?.acceptance
            .nativeRankCompletion
        ).toBe(acceptance.nativeRankCompletion);
        expect(
          (await service.status(competition)).migration?.acceptance
        ).toEqual(acceptance);
      }
      await expect(
        service.recordEnvironmentAcceptance(
          { actor: 'other', reason: 'mismatch' },
          acceptance
        )
      ).rejects.toThrow('recording operator');
    }, 60000);

    it('never treats a staging per-wave attestation as production approval and refuses an expired current review', async () => {
      const clock = { value: 1000000000 };
      const staging = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'staging'
      );
      const production = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'production'
      );
      await staging.enroll(prior, operator, 'COMPLETED_ORDINARY');
      await staging.recordAcceptance(
        prior,
        operator,
        migrationFixtureAcceptance(clock.value)
      );
      expect(
        (await production.status(prior)).migration?.acceptance
      ).not.toBeNull();
      expect(
        (await production.status(prior)).readiness?.acceptance
          .nativeRankCompletion
      ).toBeNull();
      expect((await production.inspectWave(completed.id)).failures).toContain(
        'ENVIRONMENT_ACCEPTANCE_REQUIRED'
      );
      const valid = migrationFixtureAcceptance(clock.value);
      await production.recordEnvironmentAcceptance(operator, valid);
      clock.value += 1;
      await production.recordEnvironmentAcceptance(operator, {
        ...valid,
        productionEvidenceVerifiedAt: clock.value - 86400001
      });
      expect((await production.inspectWave(completed.id)).failures).toContain(
        'VERIFIED_PRODUCTION_EVIDENCE'
      );
      expect(await production.cutover(prior, operator, false)).toMatchObject({
        changed: false
      });
      expect((await production.status(prior)).storageMode).toBe(
        'LEGACY_ADAPTER'
      );
    });

    it('starts fresh production parity windows when the shared rollout review changes', async () => {
      const clock = { value: 10000 };
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => clock.value,
        0,
        'production'
      );
      await service.enroll(prior, operator, 'COMPLETED_ORDINARY');
      await finishMigrationFixture(service, prior);
      await approveMigrationFixture(service, prior, clock);
      expect((await service.readiness(prior)).failures).toEqual([]);
      clock.value += 1;
      const replacement = {
        ...migrationFixtureAcceptance(clock.value),
        nativeRankCompletion: 'https://example.test/reviewed/new-rank'
      };
      await service.recordEnvironmentAcceptance(operator, replacement);
      expect((await service.readiness(prior)).failures).toContain(
        'CURRENT_ENVIRONMENT_ACCEPTANCE'
      );
      expect(await service.cutover(prior, operator, false)).toMatchObject({
        changed: false,
        failures: expect.arrayContaining(['CURRENT_ENVIRONMENT_ACCEPTANCE'])
      });
      expect(
        (await service.compare(prior, operator, 60000)).consecutiveFullWindows
      ).toBe(0);
      expect((await service.status(prior)).migration?.acceptance).toEqual(
        replacement
      );
      expect((await service.readiness(prior)).failures).toContain(
        'SEVEN_FULL_INDEPENDENT_WINDOWS'
      );
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
        expect(await service.cutover(id, operator, true)).toMatchObject({
          changed: false,
          failures: ['COMPLETED_COHORT_FIRST']
        });
        await service.enroll(prior, operator, 'COMPLETED_INTERNAL');
        await finishMigrationFixture(service, prior);
        await approveMigrationFixture(service, prior, clock);
        expect(await service.cutover(prior, operator, false)).toMatchObject({
          changed: true
        });
        // Re-observe the active source at the final current watermark after the prior cohort.
        await service.compare(id, operator, 60000);
        // The missed sampling interval reset its windows; all seven must be rebuilt.
        for (let window = 0; window < 7; window++) {
          clock.value += 60000;
          await service.compare(id, operator, 60000);
        }
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
