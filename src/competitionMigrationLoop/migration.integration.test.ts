import { CompetitionMigrationService } from '@/competitions/competition-migration.service';
import {
  withLegacyPrimaryMutation,
  reconcileAcceptedLegacySettings
} from '@/competitions/legacy-competition-mutation';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { installMigrationCapture } from '@/competitions/competition-migration-capture';
import { legacyCompetitionId } from '@/competitions/competition-id';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { WaveType } from '@/entities/IWave';
import {
  DROPS_TABLE,
  DROPS_PARTS_TABLE,
  DROP_RANK_TABLE,
  COMPETITION_ENTRIES_TABLE,
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITION_CONFIG_VERSIONS_TABLE,
  COMPETITIONS_TABLE,
  COMPETITION_MIGRATIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import {
  parseMigrationLambdaInput,
  type MigrationLambdaInput
} from './migration-input';
import { executeMigrationLambdaInput } from './migration-runner';

const waveId = '047b77f0-49e2-4fb7-a564-33b43aa610f5';
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
  { id: waveId, name: 'Disposable remote Lambda pilot', serial_no: 1 }
);
const dropId = 'remote-migration-fixture-drop';
const author = anIdentity(
  { tdh: 100 },
  {
    profile_id: 'remote-fixture-author',
    consolidation_key: '0xremote',
    primary_address: '0xremote',
    handle: 'remote-fixture-author'
  }
);

describeWithSeed(
  'remote Lambda migration in disposable MySQL',
  [
    withWaves([wave]),
    withIdentities([author]),
    {
      table: DROPS_TABLE,
      rows: [
        {
          id: dropId,
          wave_id: waveId,
          author_id: author.profile_id,
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
      table: DROPS_PARTS_TABLE,
      rows: [
        {
          drop_id: dropId,
          drop_part_id: 1,
          content: 'Disposable remote entry',
          wave_id: null
        }
      ]
    },
    {
      table: DROP_RANK_TABLE,
      rows: [
        {
          drop_id: dropId,
          wave_id: waveId,
          vote: 0,
          last_increased: 10
        }
      ]
    }
  ],
  () => {
    const originalMainStage = process.env.MAIN_STAGE_WAVE_ID;
    const originalWrites = process.env.FEATURE_NATIVE_COMPETITION_WRITES;
    const originalExecution = process.env.FEATURE_NATIVE_COMPETITION_EXECUTION;
    beforeEach(async () => {
      if (originalMainStage === undefined)
        delete process.env.MAIN_STAGE_WAVE_ID;
      else process.env.MAIN_STAGE_WAVE_ID = originalMainStage;
      process.env.FEATURE_NATIVE_COMPETITION_WRITES = 'true';
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'true';
      await new CompetitionRepository().ensureLegacyMappingForWave(wave, {});
      await installMigrationCapture(sqlExecutor);
    });
    afterAll(() => {
      if (originalMainStage === undefined)
        delete process.env.MAIN_STAGE_WAVE_ID;
      else process.env.MAIN_STAGE_WAVE_ID = originalMainStage;
      if (originalWrites === undefined)
        delete process.env.FEATURE_NATIVE_COMPETITION_WRITES;
      else process.env.FEATURE_NATIVE_COMPETITION_WRITES = originalWrites;
      if (originalExecution === undefined)
        delete process.env.FEATURE_NATIVE_COMPETITION_EXECUTION;
      else process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = originalExecution;
    });
    it('migrates an active signed Main Stage source with upper-threshold metadata without a prior pilot', async () => {
      process.env.MAIN_STAGE_WAVE_ID = waveId;
      await sqlExecutor.execute(
        `update ${WAVES_TABLE} set type='APPROVE',decisions_strategy=null,next_decision_time=null,
         participation_period_end=1900000100000,voting_period_end=1900000100000,
         winning_min_threshold=1,winning_max_threshold=10,winning_threshold_min_duration_ms=0,
         voting_signature_required=1 where id=:waveId`,
        { waveId }
      );
      const id = legacyCompetitionId(waveId);
      await sqlExecutor.execute(
        `insert into ${COMPETITION_CAPABILITIES_TABLE} (competition_id,wave_id,capability,assigned_at)
         values (:id,:waveId,'MAIN_STAGE',1)`,
        { id, waveId }
      );
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => 1900000000000,
        0,
        'staging'
      );
      expect((await service.inspectWave(waveId)).failures).toEqual([]);
      const result = await executeMigrationLambdaInput(
        parseMigrationLambdaInput({ wave_id: waveId }),
        service,
        {
          environment: 'staging',
          now: () => 1900000000000,
          remainingTime: () => 900000,
          wait: async () => {
            throw new Error('No timed waiting expected');
          },
          progress: () => undefined,
          continueMigration: async () => {
            throw new Error('No continuation expected');
          }
        }
      );
      expect(result).toMatchObject({
        outcome: 'COMPLETE',
        status: { storageMode: 'NATIVE' }
      });
      const record = await sqlExecutor.oneOrNull<{
        decision_config: string;
        voting_config: string;
      }>(
        `select decision_config,voting_config from ${COMPETITIONS_TABLE} where id=:id`,
        { id }
      );
      expect(JSON.parse(record!.decision_config)).toMatchObject({
        winning_max_threshold: 10
      });
      expect(JSON.parse(record!.voting_config)).toMatchObject({
        signature_required: true
      });
      // Existing wave settings must remain editable after this source transfers.
      await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) =>
          withLegacyPrimaryMutation(waveId, { connection }, async (owner) => {
            if (!owner) throw new Error('Expected native primary owner');
            await reconcileAcceptedLegacySettings(owner, 'fixture', {
              connection
            });
          }),
        { isolationLevel: 'READ COMMITTED' }
      );
      const snapshot = await sqlExecutor.oneOrNull<{ config: string }>(
        `select config from ${COMPETITION_CONFIG_VERSIONS_TABLE} where competition_id=:id order by version desc limit 1`,
        { id }
      );
      expect(JSON.parse(snapshot!.config)).toMatchObject({
        rules: { winning_max_threshold: 10 }
      });
    });

    it('retries saved legacy data-shape failures without requiring a manual exception review', async () => {
      const id = legacyCompetitionId(waveId);
      const service = new CompetitionMigrationService(
        () => sqlExecutor,
        () => 1900000000000,
        0,
        'staging'
      );
      await service.enroll(
        id,
        { actor: 'old-operator', reason: 'old runner' },
        'COMPLETED_ORDINARY'
      );
      await sqlExecutor.execute(
        `update ${COMPETITION_MIGRATIONS_TABLE} set exceptions=:exceptions where competition_id=:id`,
        {
          id,
          exceptions: JSON.stringify([
            'MIGRATION_DATA_SHAPE:old-operator',
            'LEGACY_SIGNED_VOTE_ADAPTER:old-operator'
          ])
        }
      );
      const result = await executeMigrationLambdaInput(
        parseMigrationLambdaInput({ wave_id: waveId }),
        service,
        {
          environment: 'staging',
          now: () => 1900000000000,
          remainingTime: () => 900000,
          wait: async () => {
            throw new Error('No timed waiting expected');
          },
          progress: () => undefined,
          continueMigration: async () => {
            throw new Error('No continuation expected');
          }
        }
      );
      expect(result).toMatchObject({
        outcome: 'COMPLETE',
        status: { storageMode: 'NATIVE', migration: { exceptions: [] } }
      });
    });

    it.each(['staging', 'production'] as const)(
      'migrates in %s with only a wave ID, no acceptance and no elapsed windows',
      async (environment) => {
        const clock = { value: 1900000000000 };
        const service = new CompetitionMigrationService(
          () => sqlExecutor,
          () => clock.value,
          0,
          environment
        );
        const queued: MigrationLambdaInput[] = [];
        const runtime = {
          environment,
          now: () => clock.value,
          remainingTime: () => 900000,
          wait: async (ms: number) => {
            clock.value += ms;
          },
          progress: jest.fn(),
          continueMigration: async (input: MigrationLambdaInput) => {
            queued.push(input);
          }
        };
        const command = { wave_id: waveId };
        let input = parseMigrationLambdaInput(command);
        let completed = false;
        for (let invocation = 0; invocation < 6; invocation++) {
          const result = (await executeMigrationLambdaInput(
            input,
            service,
            runtime
          )) as { outcome: string };
          if (result.outcome === 'COMPLETE') {
            completed = true;
            break;
          }
          const status = await service.status(legacyCompetitionId(waveId));
          expect(status.storageMode).toBe('LEGACY_ADAPTER');

          expect(queued.length).toBe(invocation + 1);
          input = parseMigrationLambdaInput(queued[invocation]);
        }
        expect(completed).toBe(true);
        const status = await service.status(legacyCompetitionId(waveId));
        expect(status.storageMode).toBe('NATIVE');
        expect(clock.value).toBe(1900000000000);
        expect(status.migration?.acceptance).toBeNull();
        expect(
          (await service.verifyNative(legacyCompetitionId(waveId))).failures
        ).toEqual([]);
        const entries = await sqlExecutor.execute<{ drop_id: string }>(
          `select drop_id from ${COMPETITION_ENTRIES_TABLE} where competition_id=:id`,
          { id: legacyCompetitionId(waveId) }
        );
        expect(entries.map((entry) => entry.drop_id)).toEqual([dropId]);
        const queueCount = queued.length;
        await executeMigrationLambdaInput(
          parseMigrationLambdaInput(command),
          service,
          runtime
        );
        expect(queued).toHaveLength(queueCount);
      }
    );
  }
);
