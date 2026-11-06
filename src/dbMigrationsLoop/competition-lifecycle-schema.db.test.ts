import { DataSource } from 'typeorm';
import {
  COMPETITION_LIFECYCLE_EVENTS_TABLE,
  COMPETITION_PAUSES_TABLE
} from '@/constants';
import { CompetitionLifecycleEventEntity } from '@/entities/ICompetition';
import { describeWithSeed } from '@/tests/_setup/seed';

function source() {
  return new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    timezone: 'Etc/UTC',
    entities: [CompetitionLifecycleEventEntity],
    synchronize: false
  });
}

describeWithSeed('Competition lifecycle reason removal', [], () => {
  it('discards populated reasons while preserving lifecycle audit rows and pause history', async () => {
    const db = await source().initialize();
    try {
      await db.query(
        `ALTER TABLE ${COMPETITION_LIFECYCLE_EVENTS_TABLE} ADD COLUMN reason TEXT NULL`
      );
      await db.query(
        `INSERT INTO ${COMPETITION_LIFECYCLE_EVENTS_TABLE}
         (id,competition_id,wave_id,previous_lifecycle,lifecycle,actor_id,reason,created_at)
         VALUES ('archive','competition','wave','PUBLISHED','ARCHIVED','admin','Old archive reason',100),
         ('pause','competition','wave','PUBLISHED','PUBLISHED','admin','Pause reason',50)`
      );
      await db.query(
        `INSERT INTO ${COMPETITION_PAUSES_TABLE}
         (id,competition_id,start_time,end_time,reason)
         VALUES ('pause','competition',50,75,'Pause reason')`
      );
      await db.synchronize();
      const runner = db.createQueryRunner();
      try {
        expect(
          await runner.hasColumn(COMPETITION_LIFECYCLE_EVENTS_TABLE, 'reason')
        ).toBe(false);
        expect(await runner.hasColumn(COMPETITION_PAUSES_TABLE, 'reason')).toBe(
          true
        );
      } finally {
        await runner.release();
      }
      expect(
        await db.query(
          `SELECT id,lifecycle,actor_id,created_at FROM ${COMPETITION_LIFECYCLE_EVENTS_TABLE} ORDER BY created_at`
        )
      ).toEqual([
        {
          id: 'pause',
          lifecycle: 'PUBLISHED',
          actor_id: 'admin',
          created_at: '50'
        },
        {
          id: 'archive',
          lifecycle: 'ARCHIVED',
          actor_id: 'admin',
          created_at: '100'
        }
      ]);
      expect(
        await db.query(`SELECT reason FROM ${COMPETITION_PAUSES_TABLE}`)
      ).toEqual([{ reason: 'Pause reason' }]);
      await expect(db.synchronize()).resolves.toBeUndefined();
    } finally {
      await db.destroy();
    }
  });
});
