import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '@/env';
import { ProfileGroupEntity } from '@/entities/IProfileGroup';
import { describeWithSeed } from '@/tests/_setup/seed';
import { applyProfileGroupsCollationSchema } from './profile-groups-collation-schema';

const noWait = () => Promise.resolve();

async function columnCollations(source: DataSource) {
  const rows: { column_name: string; collation_name: string }[] =
    await source.query(
      `SELECT column_name AS column_name, collation_name AS collation_name
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'profile_groups'
       ORDER BY ordinal_position`
    );
  return rows.map((row) => `${row.column_name}:${row.collation_name}`);
}

async function indexNames(source: DataSource) {
  const rows: { index_name: string }[] = await source.query(
    `SELECT DISTINCT index_name AS index_name
     FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'profile_groups'
     ORDER BY index_name`
  );
  return rows.map((row) => row.index_name);
}

describeWithSeed('profile_groups collation change', [], () => {
  it('converts the legacy utf8mb3_bin ids, keeps data and indexes, survives sync and reverts', async () => {
    const source = new DataSource({
      type: 'mysql',
      host: env.getStringOrThrow('DB_HOST'),
      port: env.getIntOrThrow('DB_PORT'),
      username: env.getStringOrThrow('DB_USER'),
      password: env.getStringOrThrow('DB_PASS'),
      database: env.getStringOrThrow('DB_NAME'),
      entities: [ProfileGroupEntity],
      synchronize: false
    });
    await source.initialize();
    try {
      // Production's shape: both ids utf8mb3_bin on a utf8mb4 table.
      await source.query(
        `ALTER TABLE profile_groups
           MODIFY profile_group_id varchar(50) CHARACTER SET utf8mb3 COLLATE utf8mb3_bin NOT NULL,
           MODIFY profile_id varchar(100) CHARACTER SET utf8mb3 COLLATE utf8mb3_bin NOT NULL`
      );
      await source.query(
        `INSERT INTO profile_groups (profile_group_id, profile_id) VALUES
           ('3f0c2a8e-1111-4c7a-9a55-000000000001', 'b1e5d7c2-2222-4f1a-8e44-000000000001'),
           ('3f0c2a8e-1111-4c7a-9a55-000000000001', 'b1e5d7c2-2222-4f1a-8e44-000000000002'),
           ('3f0c2a8e-1111-4c7a-9a55-000000000002', 'b1e5d7c2-2222-4f1a-8e44-000000000001')`
      );
      const indexesBefore = await indexNames(source);
      expect(await columnCollations(source)).toEqual([
        'profile_group_id:utf8mb3_bin',
        'profile_id:utf8mb3_bin'
      ]);

      await expect(
        applyProfileGroupsCollationSchema('convert', source, noWait)
      ).resolves.toBe(1);
      await expect(
        applyProfileGroupsCollationSchema('convert', source, noWait)
      ).resolves.toBe(0);
      expect(await columnCollations(source)).toEqual([
        'profile_group_id:utf8mb4_0900_ai_ci',
        'profile_id:utf8mb4_0900_ai_ci'
      ]);
      expect(await indexNames(source)).toEqual(indexesBefore);

      // Entity sync never changes column collations back.
      await source.synchronize();
      await expect(
        applyProfileGroupsCollationSchema('convert', source, noWait)
      ).resolves.toBe(0);

      const [count] = await source.query(
        'SELECT count(*) AS memberships FROM profile_groups'
      );
      expect(Number(count.memberships)).toBe(3);

      await expect(
        applyProfileGroupsCollationSchema('revert', source, noWait)
      ).resolves.toBe(1);
      expect(await columnCollations(source)).toEqual([
        'profile_group_id:utf8mb3_bin',
        'profile_id:utf8mb3_bin'
      ]);
      await expect(
        applyProfileGroupsCollationSchema('convert', source, noWait)
      ).resolves.toBe(1);
    } finally {
      await source.query('DELETE FROM profile_groups');
      await source.destroy();
    }
  });
});
