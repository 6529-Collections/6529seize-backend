import { CompetitionMigrationService } from '@/competitions/competition-migration.service';
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
  COMPETITION_ENTRIES_TABLE
} from '@/constants';
import {
  migrationFixtureAcceptance,
  migrationFixtureOperator
} from '@/tests/fixtures/competition-migration.fixture';
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
    const originalWrites = process.env.FEATURE_NATIVE_COMPETITION_WRITES;
    const originalExecution = process.env.FEATURE_NATIVE_COMPETITION_EXECUTION;
    beforeEach(async () => {
      process.env.FEATURE_NATIVE_COMPETITION_WRITES = 'true';
      process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = 'true';
      await new CompetitionRepository().ensureLegacyMappingForWave(wave, {});
      await installMigrationCapture(sqlExecutor);
    });
    afterAll(() => {
      if (originalWrites === undefined)
        delete process.env.FEATURE_NATIVE_COMPETITION_WRITES;
      else process.env.FEATURE_NATIVE_COMPETITION_WRITES = originalWrites;
      if (originalExecution === undefined)
        delete process.env.FEATURE_NATIVE_COMPETITION_EXECUTION;
      else process.env.FEATURE_NATIVE_COMPETITION_EXECUTION = originalExecution;
    });
    it.each(['staging', 'production'] as const)(
      'requires %s acceptance and resumes real durable checkpoints until seven full parity windows pass',
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
        const command = {
          environment,
          wave_id: waveId,
          action: 'migrate',
          live: true,
          operator: migrationFixtureOperator.actor,
          reason: migrationFixtureOperator.reason,
          invocation_seconds: 120,
          batch: 1
        };
        const inspect = await executeMigrationLambdaInput(
          parseMigrationLambdaInput({ ...command, live: false }),
          service,
          runtime
        );
        expect(inspect).toMatchObject({
          failures: ['ENVIRONMENT_ACCEPTANCE_REQUIRED']
        });
        await expect(
          executeMigrationLambdaInput(
            parseMigrationLambdaInput(command),
            service,
            runtime
          )
        ).rejects.toThrow('ENVIRONMENT_ACCEPTANCE_REQUIRED');
        expect(
          (await service.status(legacyCompetitionId(waveId))).migration
        ).toBeNull();
        await executeMigrationLambdaInput(
          parseMigrationLambdaInput({
            environment,
            action: 'record-environment-acceptance',
            live: true,
            operator: migrationFixtureOperator.actor,
            reason: migrationFixtureOperator.reason,
            acceptance: migrationFixtureAcceptance(clock.value)
          }),
          service,
          runtime
        );
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
          expect(status.migration?.consecutive_full_windows).toBeLessThan(7);
          expect(queued.length).toBe(invocation + 1);
          input = parseMigrationLambdaInput(queued[invocation]);
        }
        expect(completed).toBe(true);
        const status = await service.status(legacyCompetitionId(waveId));
        expect(status.storageMode).toBe('NATIVE');
        expect(
          status.migration?.consecutive_full_windows
        ).toBeGreaterThanOrEqual(7);
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
