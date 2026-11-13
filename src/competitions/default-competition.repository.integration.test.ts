import { COMPETITION_DECISIONS_TABLE, COMPETITIONS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { seedNativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import { WaveType } from '@/entities/IWave';
import { CompetitionRepository } from './competition.repository';
import { legacyGetView } from './legacy-competition-get-facade';

const wave = aWave(
  { type: WaveType.RANK },
  { id: 'summary-primary', name: 'Summary', serial_no: 1 }
);
describeWithSeed(
  'permanent original-primary decision summary',
  withWaves([wave]),
  () => {
    it('reads native completed decisions and excludes native-only siblings', async () => {
      const primary = await seedNativeOriginalPrimaryFixture(wave);
      await sqlExecutor.bulkInsert(
        COMPETITION_DECISIONS_TABLE,
        [10, 30].map((time, index) => ({
          id: `10000000-0000-4000-8000-00000000000${index}`,
          competition_id: primary.id,
          scheduled_at: time,
          decided_at: time,
          status: 'COMPLETED',
          execution_key: `decision:${time}`,
          created_at: time
        })),
        [
          'id',
          'competition_id',
          'scheduled_at',
          'decided_at',
          'status',
          'execution_key',
          'created_at'
        ]
      );
      const result = await sqlExecutor.execute(
        `select max(decision_time) as last_decision_time,count(*) as decisions_done from \`${legacyGetView('wave_decisions')}\` where wave_id=:id`,
        { id: wave.id }
      );
      expect(result).toEqual([{ last_decision_time: 30, decisions_done: 2 }]);
      await sqlExecutor.execute(
        `update ${COMPETITIONS_TABLE} set legacy_wave_id=null where id=:id`,
        { id: primary.id }
      );
      expect(
        await sqlExecutor.execute(
          `select * from \`${legacyGetView('wave_decisions')}\``
        )
      ).toEqual([]);
      expect(
        await new CompetitionRepository(
          () => sqlExecutor
        ).listDefaultCompetitionRecords(wave.id, {})
      ).toHaveLength(1);
    });
  }
);
