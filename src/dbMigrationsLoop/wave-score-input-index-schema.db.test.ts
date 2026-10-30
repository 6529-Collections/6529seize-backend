import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '@/env';
import { DropEntity } from '@/entities/IDrop';
import { describeWithSeed } from '@/tests/_setup/seed';
import { applyWaveScoreInputIndexSchema } from './wave-score-input-index-schema';

describeWithSeed('Wave score input index online DDL', [], () => {
  it('adds the covering index without losing data and remains idempotent across entity sync', async () => {
    const source = new DataSource({
      type: 'mysql',
      host: env.getStringOrThrow('DB_HOST'),
      port: env.getIntOrThrow('DB_PORT'),
      username: env.getStringOrThrow('DB_USER'),
      password: env.getStringOrThrow('DB_PASS'),
      database: env.getStringOrThrow('DB_NAME'),
      entities: [DropEntity],
      synchronize: false
    });
    await source.initialize();
    try {
      await source.query(
        'ALTER TABLE drops DROP INDEX idx_drop_wave_author_created'
      );
      await source.query(
        `INSERT INTO drops (id, wave_id, author_id, created_at, parts_count, drop_type)
         VALUES ('index-test', 'wave', 'author', 12345, 1, 'CHAT')`
      );
      await expect(applyWaveScoreInputIndexSchema(source)).resolves.toBe(1);
      await expect(applyWaveScoreInputIndexSchema(source)).resolves.toBe(0);
      await source.synchronize();
      await expect(applyWaveScoreInputIndexSchema(source)).resolves.toBe(0);
      const [row] = await source.query('SELECT count(*) AS posts FROM drops');
      expect(Number(row.posts)).toBe(1);
      const [plan] = await source.query(
        `EXPLAIN SELECT wave_id, author_id, count(*), max(created_at)
         FROM drops FORCE INDEX (idx_drop_wave_author_created)
         WHERE wave_id='wave' GROUP BY wave_id, author_id`
      );
      expect(plan.key).toBe('idx_drop_wave_author_created');
      expect(plan.Extra).toContain('Using index');
    } finally {
      await source.destroy();
    }
  });
});
