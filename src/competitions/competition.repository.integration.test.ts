import {
  COMPETITIONS_TABLE,
  COMPETITION_CAPABILITIES_TABLE
} from '@/constants';
import { CompetitionCapability } from '@/entities/ICompetition';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { CompetitionRepository } from './competition.repository';
import { legacyGetView } from './legacy-competition-get-facade';
import {
  normalizeDefaultCompetition,
  selectDefaultCompetition
} from './default-competition';

const wave = aWave(
  {
    type: WaveType.RANK,
    participation_period_start: 100,
    voting_period_start: 100
  },
  { id: 'retained-primary', name: 'Original primary', serial_no: 1 }
);
describeWithSeed(
  'native original-primary identity and independent capabilities',
  withWaves([wave]),
  () => {
    const repository = new CompetitionRepository(() => sqlExecutor);
    it('keeps old GET ownership fixed when another native competition becomes default', async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      const sibling = '10000000-0000-4000-8000-000000000001';
      const siblingRow = {
        ...primary,
        id: sibling,
        legacy_wave_id: null,
        title: 'Sibling',
        participation_starts_at: 0,
        voting_starts_at: 0
      };
      const encoded = Object.fromEntries(
        Object.entries(siblingRow).map(([key, value]) => [
          key,
          value !== null && typeof value === 'object'
            ? JSON.stringify(value)
            : value
        ])
      );
      await sqlExecutor.bulkInsert(
        COMPETITIONS_TABLE,
        [encoded],
        Object.keys(encoded)
      );
      const records = await repository.listCompetitionRecordsForWave(
        wave.id,
        {}
      );
      const defaults = await repository.listDefaultCompetitionRecords(
        wave.id,
        {}
      );
      expect(
        selectDefaultCompetition(
          defaults.flatMap((record) => {
            const input = normalizeDefaultCompetition(record, 200);
            return input ? [input] : [];
          }),
          200
        ).competition_id
      ).toBe(sibling);
      expect(
        records.find((record) => record.legacy_wave_id === wave.id)?.id
      ).toBe(primary.id);
      expect(
        await sqlExecutor.execute(
          `select name,type from \`${legacyGetView('waves')}\` where id=:id`,
          { id: wave.id }
        )
      ).toEqual([{ name: wave.name, type: 'RANK' }]);
    });
    it('uses stored capability assignments independently of wave environment settings', async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      await sqlExecutor.bulkInsert(
        COMPETITION_CAPABILITIES_TABLE,
        [
          {
            competition_id: primary.id,
            wave_id: wave.id,
            capability: CompetitionCapability.CURATION,
            assigned_by: 'admin',
            assigned_at: 10
          }
        ],
        [
          'competition_id',
          'wave_id',
          'capability',
          'assigned_by',
          'assigned_at'
        ]
      );
      expect(await repository.findCapabilities(primary.id, {})).toEqual([
        CompetitionCapability.CURATION
      ]);
      expect(await repository.findCapabilities('missing', {})).toEqual([]);
    });
  }
);
