import {
  COMPETITION_CAPABILITIES_TABLE,
  COMPETITIONS_TABLE
} from '@/constants';
import {
  CompetitionCapability,
  CompetitionExecutionMode,
  CompetitionLifecycle,
  CompetitionStorageMode,
  CompetitionType
} from '@/entities/ICompetition';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { legacyCompetitionId } from '@/competitions/competition-id';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { LegacyCompetitionAdapter } from '@/competitions/legacy-competition.adapter';
import { wavesApiDb } from '@/api/waves/waves.api.db';

const chat = aWave(
  { type: WaveType.CHAT },
  { id: 'wave-chat', name: 'Chat', serial_no: 1 }
);
const rank = aWave(
  { type: WaveType.RANK },
  { id: 'wave-rank', name: 'Rank', serial_no: 2 }
);
const approve = aWave(
  { type: WaveType.APPROVE },
  { id: 'wave-approve', name: 'Approve', serial_no: 3 }
);

describeWithSeed(
  'CompetitionRepository immutable legacy mappings',
  withWaves([chat, rank, approve]),
  () => {
    const repository = new CompetitionRepository(() => sqlExecutor);

    afterEach(() => {
      delete process.env.MAIN_STAGE_WAVE_ID;
    });

    it('backfills exactly one stable primary for every non-chat wave', async () => {
      await expect(repository.backfillLegacyMappings({})).resolves.toBe(2);
      await expect(repository.backfillLegacyMappings({})).resolves.toBe(0);

      await expect(
        repository.listCompetitionRecordsForWave(chat.id, {})
      ).resolves.toEqual([]);
      const rankRecords = await repository.listCompetitionRecordsForWave(
        rank.id,
        {}
      );
      const approveRecords = await repository.listCompetitionRecordsForWave(
        approve.id,
        {}
      );
      expect(rankRecords).toHaveLength(1);
      expect(approveRecords).toHaveLength(1);
      expect(rankRecords[0]).toMatchObject({
        id: legacyCompetitionId(rank.id),
        wave_id: rank.id,
        legacy_wave_id: rank.id,
        storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
        execution_mode: CompetitionExecutionMode.ACTIVE,
        type: CompetitionType.RANK
      });
      expect(approveRecords[0]).toMatchObject({
        id: legacyCompetitionId(approve.id),
        legacy_wave_id: approve.id,
        type: CompetitionType.APPROVE
      });
    });

    it('never lets an additional competition replace the legacy primary', async () => {
      await repository.backfillLegacyMappings({});
      const nativeId = '00000000-0000-4000-8000-000000000001';
      await sqlExecutor.execute(
        `insert into ${COMPETITIONS_TABLE}
         (id, wave_id, legacy_wave_id, storage_mode, execution_mode, type,
          lifecycle, title, description, participation_config, voting_config,
          decision_config, winner_config, outcome_config, config_version,
          participation_starts_at, participation_ends_at, voting_starts_at,
          voting_ends_at, created_at, updated_at, published_at, ended_at,
          cancelled_at, archived_at)
         values (:id, :waveId, null, :storageMode, :executionMode, :type,
          :lifecycle, 'Additional', null, '{}', '{}', '{}', '{}', '[]', 1,
          null, null, null, null, 2, 2, 2, null, null, null)`,
        {
          id: nativeId,
          waveId: rank.id,
          storageMode: CompetitionStorageMode.NATIVE,
          executionMode: CompetitionExecutionMode.DISABLED,
          type: CompetitionType.APPROVE,
          lifecycle: CompetitionLifecycle.PUBLISHED
        }
      );

      const records = await repository.listCompetitionRecordsForWave(
        rank.id,
        {}
      );
      expect(records).toHaveLength(2);
      expect(
        records.find((record) => record.legacy_wave_id === rank.id)?.id
      ).toBe(legacyCompetitionId(rank.id));
      expect(
        records.find((record) => record.id === nativeId)?.legacy_wave_id
      ).toBeNull();
    });

    it('keeps the primary ID stable and appends config history on legacy edits', async () => {
      await repository.backfillLegacyMappings({});
      await expect(
        repository.ensureLegacyMappingForWave(
          {
            ...rank,
            name: 'Rank updated',
            updated_at: Number(rank.created_at) + 100
          },
          {}
        )
      ).resolves.toBe(false);

      const [record] = await repository.listCompetitionRecordsForWave(
        rank.id,
        {}
      );
      expect(record).toMatchObject({
        id: legacyCompetitionId(rank.id),
        legacy_wave_id: rank.id,
        config_version: 2,
        title: 'Rank updated',
        storage_mode: CompetitionStorageMode.LEGACY_ADAPTER,
        execution_mode: CompetitionExecutionMode.ACTIVE
      });
      const versions = await repository.listConfigVersions(
        record!.id,
        { offset: 0, limit: 10, direction: 'DESC' },
        {}
      );
      expect(versions.data.map(({ version }) => version)).toEqual([2, 1]);
      expect(versions.data[0]?.config).toMatchObject({
        title: 'Rank updated',
        type: CompetitionType.RANK
      });

      const competition = await new LegacyCompetitionAdapter(
        repository,
        wavesApiDb,
        {}
      ).getCompetition(record!, Date.now());
      expect(competition.config_version).toBe(2);
    });

    it('maps the configured Main Stage capability only to its primary', async () => {
      process.env.MAIN_STAGE_WAVE_ID = rank.id;
      await repository.backfillLegacyMappings({});
      const capabilities = await sqlExecutor.execute<{
        capability: CompetitionCapability;
        competition_id: string;
        legacy_source_wave_id: string | null;
      }>(
        `select capability, competition_id, legacy_source_wave_id
         from ${COMPETITION_CAPABILITIES_TABLE}`
      );
      expect(capabilities).toEqual([
        {
          capability: CompetitionCapability.MAIN_STAGE,
          competition_id: legacyCompetitionId(rank.id),
          legacy_source_wave_id: rank.id
        }
      ]);
    });

    it('represents the same capability independently per competition', async () => {
      await repository.backfillLegacyMappings({});
      const assignedAt = Date.now();
      await sqlExecutor.execute(
        `insert into ${COMPETITION_CAPABILITIES_TABLE}
         (capability, competition_id, wave_id, assigned_by,
          legacy_source_wave_id, assigned_at)
         values (:capability, :rankCompetitionId, :rankWaveId, null, null,
          :assignedAt),
         (:capability, :approveCompetitionId, :approveWaveId, null, null,
          :assignedAt)`,
        {
          capability: CompetitionCapability.MAIN_STAGE,
          rankCompetitionId: legacyCompetitionId(rank.id),
          rankWaveId: rank.id,
          approveCompetitionId: legacyCompetitionId(approve.id),
          approveWaveId: approve.id,
          assignedAt
        }
      );

      const capabilities = await sqlExecutor.execute<{
        competition_id: string;
      }>(
        `select competition_id from ${COMPETITION_CAPABILITIES_TABLE}
         where capability = :capability order by competition_id`,
        { capability: CompetitionCapability.MAIN_STAGE }
      );
      expect(capabilities).toEqual(
        [legacyCompetitionId(rank.id), legacyCompetitionId(approve.id)]
          .sort()
          .map((competition_id) => ({ competition_id }))
      );
    });
  }
);
