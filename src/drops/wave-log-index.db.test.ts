import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { PROFILES_ACTIVITY_LOGS_TABLE } from '@/constants';
import { PageSortDirection } from '@/api/page-request';
import { applyProfileActivityLogWaveIndexSchema } from '@/dbMigrationsLoop/profile-activity-log-wave-index-schema';
import { env } from '@/env';
import {
  ProfileActivityLog,
  ProfileActivityLogType
} from '@/entities/IProfileActivityLog';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { DropsDb } from './drops.db';
import { resetWaveLogIndexReady, WAVE_LOG_INDEX } from './wave-log-index';

const repo = new DropsDb(() => sqlExecutor);
const ctx: RequestContext = { timer: undefined };
const { DROP_CREATED, DROP_VOTE_EDIT, DROP_REACTED } = ProfileActivityLogType;

const log = (
  id: string,
  waveId: string,
  type: ProfileActivityLogType,
  minute: number
) => ({
  id,
  profile_id: 'profile-1',
  target_id: `drop-${id}`,
  type,
  additional_data_2: waveId,
  contents: {},
  created_at: new Date(Date.UTC(2026, 10, 7, 12, minute))
});

const rows = [
  log('c0', 'wave-1', DROP_CREATED, 0),
  log('v1', 'wave-1', DROP_VOTE_EDIT, 1),
  log('c2', 'wave-1', DROP_CREATED, 2),
  log('v3', 'wave-1', DROP_VOTE_EDIT, 3),
  log('c4', 'wave-1', DROP_CREATED, 4),
  log('v5', 'wave-1', DROP_VOTE_EDIT, 5),
  log('c6', 'wave-1', DROP_CREATED, 6),
  log('r7', 'wave-1', DROP_REACTED, 7),
  // Same created_at as c6 and r7's neighbours: ties break on id.
  log('t6a', 'wave-1', DROP_CREATED, 6),
  log('t6b', 'wave-1', DROP_VOTE_EDIT, 6),
  log('other-c', 'wave-2', DROP_CREATED, 8),
  log('other-v', 'wave-2', DROP_VOTE_EDIT, 9)
];

async function withSource<T>(work: (source: DataSource) => Promise<T>) {
  const source = new DataSource({
    type: 'mysql',
    host: env.getStringOrThrow('DB_HOST'),
    port: env.getIntOrThrow('DB_PORT'),
    username: env.getStringOrThrow('DB_USER'),
    password: env.getStringOrThrow('DB_PASS'),
    database: env.getStringOrThrow('DB_NAME'),
    entities: [ProfileActivityLog],
    synchronize: false
  });
  await source.initialize();
  try {
    return await work(source);
  } finally {
    await source.destroy();
  }
}

describeWithSeed(
  'Whole-wave activity logs through the wave index',
  [{ table: PROFILES_ACTIVITY_LOGS_TABLE, rows }],
  () => {
    afterEach(() => resetWaveLogIndexReady());

    it('builds the index online, once, and entity sync leaves it alone', async () => {
      await withSource(async (source) => {
        const [existing] = await source.query(
          `SELECT count(*) AS n FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
          [PROFILES_ACTIVITY_LOGS_TABLE, WAVE_LOG_INDEX]
        );
        if (Number(existing.n) > 0)
          await source.query(
            `ALTER TABLE \`${PROFILES_ACTIVITY_LOGS_TABLE}\` DROP INDEX \`${WAVE_LOG_INDEX}\``
          );
        await expect(
          applyProfileActivityLogWaveIndexSchema(source)
        ).resolves.toBe(1);
        await expect(
          applyProfileActivityLogWaveIndexSchema(source)
        ).resolves.toBe(0);
        const plan = await source.driver.createSchemaBuilder().log();
        expect(
          plan.upQueries.filter((it) => it.query.includes(WAVE_LOG_INDEX))
        ).toEqual([]);
        const [row] = await source.query(
          `SELECT count(*) AS n FROM \`${PROFILES_ACTIVITY_LOGS_TABLE}\``
        );
        expect(Number(row.n)).toBe(rows.length);
      });
    });

    it('returns exactly the rows of the unindexed read', async () => {
      await withSource(applyProfileActivityLogWaveIndexSchema);
      const typeSets = [
        [DROP_CREATED, DROP_VOTE_EDIT, DROP_REACTED],
        [DROP_VOTE_EDIT],
        [DROP_CREATED, DROP_REACTED]
      ];
      for (const log_types of typeSets)
        for (const sort_direction of [
          PageSortDirection.DESC,
          PageSortDirection.ASC
        ])
          for (const [offset, limit] of [
            [0, 3],
            [2, 3],
            [5, 5],
            [1, 2],
            [3, 1],
            [0, 100]
          ]) {
            const params = {
              wave_id: 'wave-1',
              drop_id: null,
              log_types,
              sort_direction,
              offset,
              limit
            };
            resetWaveLogIndexReady(false);
            const scanned = await repo.findDropLogEntities(params, ctx);
            resetWaveLogIndexReady(true);
            const indexed = await repo.findDropLogEntities(params, ctx);
            expect({ params, ids: indexed.map((it) => it.id) }).toEqual({
              params,
              ids: scanned.map((it) => it.id)
            });
          }
    });
  }
);
