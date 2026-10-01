import path from 'node:path';
import { CompetitionRepository } from '@/competitions/competition.repository';
import { WAVES_DECISIONS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

type Migration = {
  up: (db: { runSql: (sql: string) => Promise<unknown> }) => Promise<unknown>;
  down: () => Promise<unknown>;
};
const migration = require(
  path.resolve(
    process.cwd(),
    'migrations/20261001120000-add-default-competition-decision-index.js'
  )
) as Migration;

describeWithSeed(
  'default competition legacy decision summary',
  {
    table: WAVES_DECISIONS_TABLE,
    rows: [
      { wave_id: 'selected', decision_time: 10 },
      { wave_id: 'selected', decision_time: 30 },
      ...Array.from({ length: 100 }, (_, i) => ({
        wave_id: 'other',
        decision_time: i + 100
      }))
    ]
  },
  () => {
    it('aggregates only the selected wave through an online covering index', async () => {
      const db = { runSql: (sql: string) => sqlExecutor.execute(sql) };
      await migration.up(db);
      await migration.up(db);
      const repository = new CompetitionRepository(() => sqlExecutor);
      await expect(
        repository.getLegacyDecisionSummary('selected', {})
      ).resolves.toEqual({
        last_decision_time: 30,
        decisions_done: 2
      });
      await expect(
        repository.getLegacyDecisionSummary('absent', {})
      ).resolves.toEqual({
        last_decision_time: null,
        decisions_done: 0
      });
      const plan = await sqlExecutor.execute<{ key: string; Extra: string }>(
        `explain select max(decision_time), count(*) from ${WAVES_DECISIONS_TABLE} where wave_id = :waveId`,
        { waveId: 'selected' }
      );
      expect(plan[0]?.key).toBe('idx_wave_decisions_wave_time');
      expect(plan[0]?.Extra).toContain('Using index');
      await migration.down();
      const rollbackPlan = await sqlExecutor.execute<{
        key: string;
        Extra: string;
      }>(
        `explain select max(decision_time), count(*) from ${WAVES_DECISIONS_TABLE} where wave_id = :waveId`,
        { waveId: 'selected' }
      );
      expect(rollbackPlan[0]?.key).toBe('idx_wave_decisions_wave_time');
      expect(rollbackPlan[0]?.Extra).toContain('Using index');
      await expect(
        repository.getLegacyDecisionSummary('selected', {})
      ).resolves.toMatchObject({ decisions_done: 2 });
    });
  }
);

it('propagates online DDL failures instead of retrying with a blocking table lock', async () => {
  const error = Object.assign(new Error('online index unavailable'), {
    code: 'ER_LOCK_WAIT_TIMEOUT'
  });
  await expect(
    migration.up({ runSql: jest.fn().mockRejectedValue(error) })
  ).rejects.toBe(error);
});
