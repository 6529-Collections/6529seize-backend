import { randomUUID } from 'node:crypto';
import { appFeatures } from '@/app-features';
import { AuthenticationContext } from '@/auth-context';
import { ApiWaveOutcomeType } from '@/api/generated/models/ApiWaveOutcomeType';
import {
  COMPETITIONS_TABLE,
  COMPETITION_PAUSES_TABLE,
  COMPETITION_VOTES_TABLE,
  COMPETITION_OUTCOMES_TABLE,
  COMPETITION_LEGACY_MIRROR_PERMITS_TABLE,
  DROP_REAL_VOTER_VOTE_IN_TIME_TABLE,
  PROFILES_ACTIVITY_LOGS_TABLE,
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  WAVES_DECISION_PAUSES_TABLE,
  WAVES_TABLE
} from '@/constants';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { competitionRepository } from './competition.repository';
import {
  legacyCompetitionId,
  legacyCompetitionPauseId
} from './competition-id';
import { loadNativeCommandConfiguration } from '@/api/competitions/competition-command-configuration';
import {
  applyAcceptedLegacyPause,
  reconcileAcceptedLegacySettings,
  withLegacyPrimaryMutation
} from './legacy-competition-mutation';
import { legacyWaveUpdate } from '@/api/competitions/legacy-competition-settings.service';
import { waveApiService } from '@/api/waves/wave.api.service';
import { competitionLifecycleService } from '@/api/competitions/competition-lifecycle.service';
import { withLegacyCompetitionProfileMerge } from './legacy-competition-profile-merge';

const first = Date.now() + 86_400_000;
const progressed = first + 86_400_000;
const identity = anIdentity(
  {},
  {
    profile_id: 'preparation-admin',
    handle: 'preparation-admin',
    primary_address: '0x0000000000000000000000000000000000000529',
    consolidation_key: 'preparation-admin'
  }
);
const wave = aWave({
  created_by: identity.profile_id!,
  type: WaveType.RANK,
  next_decision_time: first,
  decisions_strategy: {
    first_decision_time: first,
    subsequent_decisions: [86_400_000],
    is_rolling: true
  }
});
const id = legacyCompetitionId(wave.id);
const ctx = {
  authenticationContext: AuthenticationContext.fromProfileId(wave.created_by)
};

describeWithSeed(
  'Native authority during preparation overlap',
  [
    withWaves([wave]),
    withIdentities([identity]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: wave.description_drop_id,
          wave_id: wave.id,
          author_id: wave.created_by,
          created_at: 1000,
          parts_count: 1,
          drop_type: 'CHAT'
        }
      ]
    },
    {
      table: DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: wave.description_drop_id,
          drop_part_id: 1,
          content: 'Description'
        }
      ]
    }
  ],
  () => {
    beforeEach(async () => {
      jest
        .spyOn(appFeatures, 'isUnifiedCompetitionReadsEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionWritesEnabled')
        .mockReturnValue(true);
      jest
        .spyOn(appFeatures, 'isNativeCompetitionExecutionEnabled')
        .mockReturnValue(true);
      await competitionRepository.ensureLegacyMappingForWave(wave, ctx);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set storage_mode='NATIVE',decision_config=json_set(decision_config,'$.next_decision_time',:progressed,'$.winning_max_threshold',123),winner_config=json_set(winner_config,'$.winning_max_threshold',123) where id=:id`,
        { id, progressed }
      );
    });
    afterEach(() => jest.restoreAllMocks());

    it('keeps original outcome definitions fixed before any entry during the rolling switch', async () => {
      const config = await competitionLifecycleService.configuration(
        wave.id,
        id,
        ctx
      );
      const record = await competitionRepository.findCompetitionRecordById(
        id,
        ctx
      );
      await expect(
        competitionLifecycleService.update(
          wave.id,
          id,
          {
            idempotency_key: randomUUID(),
            config_version: Number(record!.config_version),
            config: {
              ...config,
              outcomes: [
                {
                  type: ApiWaveOutcomeType.Manual,
                  description: 'New outcome',
                  amount: 1
                }
              ]
            }
          },
          ctx
        )
      ).rejects.toThrow(
        'Original competition outcome definitions are immutable'
      );
    });

    it('retains progressed scheduling, original outcome identity and appearance inheritance on another native rule edit', async () => {
      const outcomeId = randomUUID();
      await sqlExecutor.execute(
        `insert into ${COMPETITION_OUTCOMES_TABLE}
         (id,competition_id,position,legacy_index,type,description,created_at)
         values(:outcomeId,:id,0,7,'MANUAL','Retained outcome',1000)`,
        { outcomeId, id }
      );
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set presentation_config=null where id=:id`,
        { id }
      );
      const config = await competitionLifecycleService.configuration(
        wave.id,
        id,
        ctx
      );
      const record = await competitionRepository.findCompetitionRecordById(
        id,
        ctx
      );
      await competitionLifecycleService.update(
        wave.id,
        id,
        {
          idempotency_key: randomUUID(),
          config_version: Number(record!.config_version),
          config: {
            ...config,
            rules: { ...config.rules, max_votes_per_identity_to_drop: 123 }
          }
        },
        ctx
      );
      const updated = await competitionRepository.findCompetitionRecordById(
        id,
        ctx
      );
      expect(
        competitionRepository.parseCompetitionRecord(updated!).decision_config
      ).toMatchObject({ next_decision_time: progressed });
      expect(updated!.presentation_config).toBeNull();
      expect(
        await sqlExecutor.execute(
          `select id,legacy_index from ${COMPETITION_OUTCOMES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([{ id: outcomeId, legacy_index: 7 }]);
    });

    it('translates accepted settings without importing stale physical schedule or outcomes', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { ...ctx, connection };
          await withLegacyPrimaryMutation(wave.id, tx, async (record) => {
            const projected = await waveApiService.findWaveByIdOrThrow(
              wave.id,
              [],
              tx
            );
            const request = {
              ...legacyWaveUpdate(projected),
              name: 'Updated native title'
            };
            expect(projected.wave.next_decision_time).toBe(progressed);
            await reconcileAcceptedLegacySettings(
              record!,
              wave.created_by,
              request,
              progressed,
              tx
            );
          });
        }
      );
      const record = (await competitionRepository.findCompetitionRecordById(
        id,
        ctx
      ))!;
      const parsed = competitionRepository.parseCompetitionRecord(record);
      expect(parsed).toMatchObject({
        title: 'Updated native title',
        decision_config: {
          next_decision_time: progressed,
          winning_max_threshold: 123
        },
        winner_config: { winning_max_threshold: 123 }
      });
      const commandConfig = await loadNativeCommandConfiguration(record, ctx);
      expect(commandConfig).toMatchObject({
        title: 'Updated native title'
      });
      expect(commandConfig.rules).not.toHaveProperty('winning_max_threshold');
      const physical = await sqlExecutor.oneOrNull<{
        next_decision_time: number | string;
      }>(`select next_decision_time from ${WAVES_TABLE} where id=:waveId`, {
        waveId: wave.id
      });
      expect(Number(physical?.next_decision_time)).toBe(first);
    });

    it('changes only the selected pause and retains native pauses missing from the old mirror', async () => {
      const start = Date.now() + 1000;
      await sqlExecutor.execute(
        `insert into ${WAVES_DECISION_PAUSES_TABLE} (id,wave_id,start_time,end_time,reason) values (901,:waveId,:start,:end,'stale physical interval')`,
        { waveId: wave.id, start, end: start + 1000 }
      );
      for (const sourceId of [901, 902])
        await sqlExecutor.execute(
          `insert into ${COMPETITION_PAUSES_TABLE} (id,competition_id,start_time,end_time,reason,legacy_source_id) values (:pauseId,:id,:start,:end,'native interval',:sourceId)`,
          {
            pauseId: legacyCompetitionPauseId(id, sourceId),
            id,
            sourceId,
            start: start + sourceId * 1000,
            end: start + sourceId * 1000 + 500
          }
        );
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          const tx = { ...ctx, connection };
          await withLegacyPrimaryMutation(wave.id, tx, async (record) =>
            applyAcceptedLegacyPause(record!, { id: 901 }, tx)
          );
        }
      );
      expect(
        await sqlExecutor.execute(
          `select legacy_source_id from ${COMPETITION_PAUSES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([{ legacy_source_id: 902 }]);
      expect(
        await sqlExecutor.execute(
          `select id from ${WAVES_DECISION_PAUSES_TABLE} where wave_id=:waveId`,
          { waveId: wave.id }
        )
      ).toEqual([]);
    });

    it('consolidates current native credit without rebuilding it from stale physical votes', async () => {
      const entryId = randomUUID();
      await sqlExecutor.execute(
        `insert into ${COMPETITION_VOTES_TABLE} (id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) values (:voteId,:id,:entryId,'source',7,7,1,1),(:targetId,:id,:entryId,'target',2,2,1,1)`,
        { id, entryId, voteId: randomUUID(), targetId: randomUUID() }
      );
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await withLegacyCompetitionProfileMerge(
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
          `select voter_profile_id,value,credit_spent from ${COMPETITION_VOTES_TABLE} where competition_id=:id`,
          { id }
        )
      ).toEqual([{ voter_profile_id: 'target', value: 9, credit_spent: 9 }]);
    });

    it.each(['raw voter', 'shared author'] as const)(
      'locks source-only %s history before the first transfer copy',
      async (source) => {
        if (source === 'raw voter')
          await sqlExecutor.execute(
            `insert into ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} (drop_id,wave_id,voter_id,timestamp,vote) values ('deleted-drop',:waveId,'source',1000,7)`,
            { waveId: wave.id }
          );
        else
          await sqlExecutor.execute(
            `insert into ${PROFILES_ACTIVITY_LOGS_TABLE} (id,profile_id,target_id,type,contents,additional_data_1,additional_data_2) values (:activityId,'voter','deleted-drop','DROP_VOTE_EDIT','{}','source',:waveId)`,
            { activityId: randomUUID(), waveId: wave.id }
          );
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            const options = { wrappedConnection: connection };
            await withLegacyCompetitionProfileMerge(
              sqlExecutor,
              ['source'],
              'target',
              async () => {
                const permit = await sqlExecutor.oneOrNull<{ depth: number }>(
                  `select depth from ${COMPETITION_LEGACY_MIRROR_PERMITS_TABLE} where competition_id=:id and connection_id=connection_id()`,
                  { id },
                  options
                );
                expect(Number(permit?.depth)).toBeGreaterThan(0);
                if (source === 'raw voter')
                  await sqlExecutor.execute(
                    `update ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} set voter_id='target' where wave_id=:waveId and voter_id='source'`,
                    { waveId: wave.id },
                    options
                  );
                else
                  await sqlExecutor.execute(
                    `update ${PROFILES_ACTIVITY_LOGS_TABLE} set additional_data_1='target' where additional_data_2=:waveId and additional_data_1='source'`,
                    { waveId: wave.id },
                    options
                  );
              },
              { connection }
            );
          }
        );
        const rows =
          source === 'raw voter'
            ? await sqlExecutor.execute(
                `select voter_id as profile_id from ${DROP_REAL_VOTER_VOTE_IN_TIME_TABLE} where wave_id=:waveId`,
                { waveId: wave.id }
              )
            : await sqlExecutor.execute(
                `select additional_data_1 as profile_id from ${PROFILES_ACTIVITY_LOGS_TABLE} where additional_data_2=:waveId`,
                { waveId: wave.id }
              );
        expect(rows).toEqual([{ profile_id: 'target' }]);
      }
    );
  }
);
