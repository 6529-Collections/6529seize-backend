import { revokeTdhBasedDropWavesOverVotes } from '@/drops/participation-drops-over-vote-revocation';
import { userNotifier } from '@/notifications/user.notifier';
import { appFeatures } from '@/app-features';
import * as claims from '@/waves/claims-builder-publisher';
import * as pushes from '@/api/push-notifications/push-notifications.service';
import {
  COMPETITION_DECISIONS_TABLE,
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

describeWithSeed(
  'transferred legacy execution and publication fences',
  [
    withWaves([active, completed]),
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
      await installMigrationCapture(sqlExecutor);
    });
    afterEach(() => jest.restoreAllMocks());

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
