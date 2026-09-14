import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import * as Entities from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  MEMBERSHIP_GENERATION_MEMBERS_TABLE as MEMBERS,
  MEMBERSHIP_GROUP_VERSIONS_TABLE as GROUPS,
  MEMBERSHIP_PUBLICATIONS_TABLE as PUBLICATIONS,
  MEMBERSHIP_REFRESH_RUNS_TABLE as RUNS,
  MEMBERSHIP_REFRESH_TARGETS_TABLE as TARGETS,
  MEMBERSHIP_SOURCE_JOBS_TABLE as JOBS,
  MEMBERSHIP_SOURCE_STATES_TABLE as SOURCES,
  WAVE_SCORE_REFRESH_REQUESTS_TABLE as WAVE_REQUESTS
} from '@/constants';
import {
  applyMembershipSchema,
  membershipSchemaEntities
} from '@/dbMigrationsLoop/membership-schema';
import type { MembershipSourceVersion } from '@/membership/membership-schema.types';

const TABLES = [MEMBERS, GROUPS, PUBLICATIONS, RUNS, TARGETS, JOBS, SOURCES];
const sourceVersion: MembershipSourceVersion = {
  scope: 'GLOBAL',
  target_id: '*',
  dimension: 'TDH_XTDH',
  version: '9007199254740993'
};
const NOW = '1789380000000';

function dataSource(membershipOnly = false) {
  return new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    timezone: 'Etc/UTC',
    entities: membershipOnly
      ? membershipSchemaEntities
      : [...membershipSchemaEntities, Entities.WaveScoreRefreshRequestEntity]
  });
}

async function insertTarget() {
  await sqlExecutor.execute(
    `insert into ${TARGETS}
      (scope, target_id, reason, available_at_millis, created_at_millis, updated_at_millis)
      values ('PROFILE', 'profile-1', 'SOURCE_COMPLETED', :now, :now, :now)`,
    { now: NOW }
  );
}

async function insertRun(id: string, lease = randomUUID()) {
  await sqlExecutor.execute(
    `insert into ${RUNS}
      (id, scope, target_id, request_version, status, spec_version, catalog_version,
       source_versions, progress_cursor, evaluation_time_millis, lease_token,
       lease_expires_at_millis, created_at_millis, updated_at_millis)
      values (:id, 'PROFILE', 'profile-1', 1, 'RUNNING', 1, 7,
        :versions, :cursor, :now, :lease, :now + 60000, :now, :now)`,
    {
      id,
      lease,
      now: NOW,
      versions: JSON.stringify([sourceVersion]),
      cursor: JSON.stringify({ after_id: null, through_id: 'group-z' })
    }
  );
}

async function publishedGroups() {
  return sqlExecutor.execute<{ group_id: string }>(
    `select m.group_id from ${PUBLICATIONS} p
     join ${RUNS} r on r.id = p.run_id and r.target_id = p.profile_id
       and r.scope = 'PROFILE' and r.status = 'COMPLETED'
     join ${MEMBERS} m on m.run_id = r.id and m.profile_id = p.profile_id
     where p.profile_id = 'profile-1' order by m.group_id`
  );
}

async function createTableSql(table: string) {
  const rows = await sqlExecutor.execute<Record<string, string>>(
    `show create table \`${table}\``
  );
  return rows[0]['Create Table'];
}

describeWithSeed('Membership refresh schema foundation', [], () => {
  it('synchronizes only seven new tables and preserves existing wave-score and July tables', async () => {
    const db = await dataSource().initialize();
    const legacyTables = [
      'user_group_members',
      'membership_refresh_requests',
      'membership_materialization_states',
      'membership_watermarks'
    ];
    try {
      // Simulate current-main schema plus surviving, unmapped July tables.
      // All destructive fixture operations target this disposable Jest database.
      for (const table of TABLES) {
        await db.query(`drop table \`${table}\``);
      }
      for (const table of legacyTables) {
        await db.query(
          `create table \`${table}\` (id varchar(100) primary key, evidence text)`
        );
        await db.query(`insert into \`${table}\` values ('retained', 'july')`);
      }
      await db.query(
        `insert into ${WAVE_REQUESTS}
          (wave_id, reason, dirty_at, attempts, last_error, created_at, updated_at)
         values ('existing-wave', 'RATING_CHANGED', 123, 2, 'retry', 100, 123)`
      );
      const before = await createTableSql(WAVE_REQUESTS);
      const baseline = await new DataSource({
        ...db.options,
        entities: db.entityMetadatas
          .filter((entity) => !TABLES.includes(entity.tableName))
          .map((entity) => entity.target)
      }).initialize();
      let baselineQueries: string[];
      try {
        baselineQueries = (
          await baseline.driver.createSchemaBuilder().log()
        ).upQueries.map((query) => query.query);
      } finally {
        await baseline.destroy();
      }
      const plan = await db.driver.createSchemaBuilder().log();
      const addedQueries = plan.upQueries.filter(
        (query) => !baselineQueries.includes(query.query)
      );
      expect(addedQueries).toHaveLength(TABLES.length);
      for (const query of addedQueries) {
        expect(query.query).toMatch(/^CREATE TABLE `membership_/);
        expect(query.query).not.toMatch(/DROP|ALTER|FOREIGN KEY/);
      }
      const scoped = await dataSource(true).initialize();
      try {
        await expect(applyMembershipSchema(scoped)).resolves.toEqual({
          created_tables: 7,
          verified_tables: 7
        });
        await expect(applyMembershipSchema(scoped)).resolves.toEqual({
          created_tables: 0,
          verified_tables: 7
        });
      } finally {
        await scoped.destroy();
      }
      expect(await createTableSql(WAVE_REQUESTS)).toBe(before);
      const wave = await db.query(`select * from ${WAVE_REQUESTS}`);
      expect(wave).toEqual([
        expect.objectContaining({
          wave_id: 'existing-wave',
          attempts: 2,
          last_error: 'retry',
          reason: 'RATING_CHANGED'
        })
      ]);
      expect(String(wave[0].dirty_at)).toBe('123');
      expect(String(wave[0].created_at)).toBe('100');
      expect(String(wave[0].updated_at)).toBe('123');
      for (const table of legacyTables) {
        expect(await db.query(`select * from \`${table}\``)).toEqual([
          { id: 'retained', evidence: 'july' }
        ]);
      }
      expect(
        (await db.driver.createSchemaBuilder().log()).upQueries.map(
          (query) => query.query
        )
      ).toEqual(baselineQueries);
    } finally {
      // Leave the database valid even if a schema assertion fails.
      await db.synchronize();
      for (const table of legacyTables) {
        await db.query(`drop table if exists \`${table}\``);
      }
      await db.destroy();
    }
  });

  it('rejects existing-table drift before executing any planned schema change', async () => {
    const db = await dataSource(true).initialize();
    try {
      await db.query(
        `alter table ${PUBLICATIONS} add column retained_evidence varchar(100)`
      );
      await expect(applyMembershipSchema(db)).rejects.toThrow('schema drift');
      expect(await createTableSql(PUBLICATIONS)).toContain('retained_evidence');
    } finally {
      await db.query(
        `alter table ${PUBLICATIONS} drop column retained_evidence`
      );
      await db.destroy();
    }
  });

  it('provides binary identity keys, recovery indexes and no foreign keys', async () => {
    const db = await dataSource().initialize();
    const runner = db.createQueryRunner();
    try {
      const tables = await runner.getTables(TABLES);
      expect(tables).toHaveLength(TABLES.length);
      for (const table of tables) {
        expect(table.foreignKeys).toHaveLength(0);
        for (const column of table.columns.filter((c) =>
          [
            'id',
            'profile_id',
            'group_id',
            'target_id',
            'run_id',
            'job_id'
          ].includes(c.name)
        )) {
          // MySQL 8 reports utf8's canonical alias.
          expect(column.collation).toMatch(/^utf8(mb3)?_bin$/);
        }
      }
      const indexes = tables.flatMap((table) =>
        table.indices.map((index) => index.name)
      );
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_mgv_catalog_group',
          'idx_mrt_available_scope_target',
          'idx_mrun_status_lease',
          'idx_mgm_profile_run_group',
          'idx_msj_status_updated'
        ])
      );
    } finally {
      await runner.release();
      await db.destroy();
    }
  });

  it('round trips exact BIGINT versions and typed JSON through TypeORM hydration', async () => {
    const db = await dataSource().initialize();
    const id = randomUUID();
    try {
      await db.getRepository(Entities.MembershipSourceStateEntity).insert({
        ...sourceVersion,
        active_jobs: 1,
        updated_at_millis: NOW
      });
      await insertRun(id);
      const source = await db
        .getRepository(Entities.MembershipSourceStateEntity)
        .findOneByOrFail({ dimension: 'TDH_XTDH' });
      expect(source.version).toBe('9007199254740993');
      expect(source.active_jobs).toBe(1);
      const run = await db
        .getRepository(Entities.MembershipRefreshRunEntity)
        .findOneByOrFail({ id });
      expect(run.source_versions).toEqual([sourceVersion]);
      expect(run.progress_cursor).toEqual({
        after_id: null,
        through_id: 'group-z'
      });
      expect(run.valid_until_millis).toBeNull();
      expect(String(run.checkpoint_version)).toBe('0');
      expect(String(run.processed_count)).toBe('0');
    } finally {
      await db.destroy();
    }
  });

  it('keeps global and profile source barriers distinct and rejects duplicate job IDs', async () => {
    const db = await dataSource().initialize();
    try {
      const sources = db.getRepository(Entities.MembershipSourceStateEntity);
      await sources.insert([
        { ...sourceVersion, active_jobs: 1, updated_at_millis: NOW },
        {
          ...sourceVersion,
          scope: 'PROFILE',
          target_id: 'profile-1',
          active_jobs: 0,
          updated_at_millis: NOW
        }
      ]);
      const jobs = db.getRepository(Entities.MembershipSourceJobEntity);
      const job = {
        scope: sourceVersion.scope,
        target_id: sourceVersion.target_id,
        dimension: sourceVersion.dimension,
        job_id: 'tdh-cycle-1',
        status: 'RUNNING' as const,
        progress: { stage: 'XTDH', after_id: 'profile-500' },
        started_version: sourceVersion.version,
        created_at_millis: NOW,
        updated_at_millis: NOW
      };
      await jobs.insert(job);
      await expect(jobs.insert(job)).rejects.toMatchObject({
        code: 'ER_DUP_ENTRY'
      });
      expect(await sources.count()).toBe(2);
      const stored = await jobs.findOneByOrFail({ job_id: job.job_id });
      expect(stored.completed_version).toBeNull();
      expect(stored.progress).toEqual(job.progress);
    } finally {
      await db.destroy();
    }
  });

  it('rolls back the source version, completion and refresh request together', async () => {
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        const options = { wrappedConnection: connection };
        await sqlExecutor.execute(
          `insert into ${SOURCES} (scope, target_id, dimension, version, updated_at_millis)
           values ('GLOBAL', '*', 'DELEGATIONS', 1, :now)`,
          { now: NOW },
          options
        );
        await sqlExecutor.execute(
          `insert into ${JOBS} (scope, target_id, dimension, job_id, status,
             started_version, completed_version, created_at_millis, updated_at_millis)
           values ('GLOBAL', '*', 'DELEGATIONS', 'job-1', 'COMPLETED', 1, 2, :now, :now)`,
          { now: NOW },
          options
        );
        await sqlExecutor.execute(
          `insert into ${TARGETS} (scope, target_id, reason, created_at_millis, updated_at_millis)
           values ('FULL', '*', 'DELEGATIONS_COMPLETED', :now, :now)`,
          { now: NOW },
          options
        );
        throw new Error('source commit failed');
      })
    ).rejects.toThrow('source commit failed');
    for (const table of [SOURCES, JOBS, TARGETS]) {
      expect(await sqlExecutor.execute(`select * from ${table}`)).toEqual([]);
    }
  });

  it('preserves newer requested work when a captured version is acknowledged', async () => {
    await insertTarget();
    await sqlExecutor.execute(
      `update ${TARGETS} set requested_version = requested_version + 1
       where scope = 'PROFILE' and target_id = 'profile-1'`
    );
    await sqlExecutor.execute(
      `update ${TARGETS}
       set completed_version = 1,
         available_at_millis = if(requested_version = 1, null, :now)
       where scope = 'PROFILE' and target_id = 'profile-1' and completed_version < 1`,
      { now: NOW }
    );
    const [target] = await sqlExecutor.execute<{
      requested_version: number;
      completed_version: number;
      available_at_millis: number;
      attempts: number;
      last_error: string | null;
    }>(`select * from ${TARGETS}`);
    expect(String(target.requested_version)).toBe('2');
    expect(String(target.completed_version)).toBe('1');
    expect(String(target.available_at_millis)).toBe(NOW);
    expect(target.attempts).toBe(0);
    expect(target.last_error).toBeNull();
  });

  it('fences a stale lease while preserving a durable keyset checkpoint', async () => {
    const id = randomUUID();
    const oldLease = randomUUID();
    const newLease = randomUUID();
    await insertRun(id, oldLease);
    await sqlExecutor.execute(
      `update ${RUNS} set lease_token = :newLease,
        progress_cursor = :cursor, checkpoint_version = checkpoint_version + 1
       where id = :id and lease_token = :oldLease`,
      {
        id,
        oldLease,
        newLease,
        cursor: JSON.stringify({ after_id: 'group-m', through_id: 'group-z' })
      }
    );
    await sqlExecutor.execute(
      `update ${RUNS} set status = 'COMPLETED'
       where id = :id and lease_token = :oldLease`,
      { id, oldLease }
    );
    const db = await dataSource().initialize();
    try {
      const run = await db
        .getRepository(Entities.MembershipRefreshRunEntity)
        .findOneByOrFail({ id });
      expect(run.status).toBe('RUNNING');
      expect(run.lease_token).toBe(newLease);
      expect(run.progress_cursor.after_id).toBe('group-m');
      expect(String(run.checkpoint_version)).toBe('1');
    } finally {
      await db.destroy();
    }
  });

  it('isolates candidate pages, rolls back partial publication and publishes an authoritative empty generation', async () => {
    const oldId = randomUUID();
    const candidateId = randomUUID();
    await insertRun(oldId);
    await insertRun(candidateId);
    await sqlExecutor.execute(
      `update ${RUNS} set status = 'COMPLETED' where id = :id`,
      { id: oldId }
    );
    await sqlExecutor.execute(
      `insert into ${MEMBERS} (run_id, group_id, profile_id)
       values (:id, 'group-old', 'profile-1')`,
      { id: oldId }
    );
    await sqlExecutor.execute(
      `insert into ${PUBLICATIONS} (profile_id, run_id, published_at_millis)
       values ('profile-1', :id, :now)`,
      { id: oldId, now: NOW }
    );
    await sqlExecutor.execute(
      `insert into ${MEMBERS} (run_id, group_id, profile_id)
       values (:id, 'group-new', 'profile-1')`,
      { id: candidateId }
    );
    await expect(
      sqlExecutor.execute(
        `insert into ${MEMBERS} (run_id, group_id, profile_id)
         values (:id, 'group-new', 'profile-1')`,
        { id: candidateId }
      )
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
    expect(await publishedGroups()).toEqual([{ group_id: 'group-old' }]);
    // This candidate becomes an empty result before publication.
    await sqlExecutor.execute(`delete from ${MEMBERS} where run_id = :id`, {
      id: candidateId
    });
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        const options = { wrappedConnection: connection };
        await sqlExecutor.execute(
          `update ${RUNS} set status = 'COMPLETED' where id = :id`,
          { id: candidateId },
          options
        );
        await sqlExecutor.execute(
          `update ${PUBLICATIONS} set run_id = :id where profile_id = 'profile-1'`,
          { id: candidateId },
          options
        );
        throw new Error('publication interrupted');
      })
    ).rejects.toThrow('publication interrupted');
    expect(await publishedGroups()).toEqual([{ group_id: 'group-old' }]);
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      await sqlExecutor.execute(
        `update ${RUNS} set status = 'COMPLETED', completed_at_millis = :now where id = :id`,
        { id: candidateId, now: NOW },
        options
      );
      await sqlExecutor.execute(
        `update ${PUBLICATIONS} set run_id = :id where profile_id = 'profile-1'`,
        { id: candidateId },
        options
      );
    });
    expect(await publishedGroups()).toEqual([]);
    expect(await sqlExecutor.execute(`select * from ${PUBLICATIONS}`)).toEqual([
      expect.objectContaining({ run_id: candidateId })
    ]);
    // Previous immutable generation is retained for in-flight readers/GC.
    expect(await sqlExecutor.execute(`select * from ${MEMBERS}`)).toHaveLength(
      1
    );
  });

  it('keeps deletion and new-group evidence discoverable after a catalogue watermark', async () => {
    const db = await dataSource().initialize();
    try {
      await db.getRepository(Entities.MembershipGroupVersionEntity).insert([
        {
          group_id: 'clean',
          catalog_version: '7',
          is_deleted: false,
          updated_at_millis: NOW
        },
        {
          group_id: 'deleted',
          catalog_version: '8',
          is_deleted: true,
          updated_at_millis: NOW
        },
        {
          group_id: 'new',
          catalog_version: '9',
          is_deleted: false,
          updated_at_millis: NOW
        }
      ]);
      const changed = await sqlExecutor.execute<{ group_id: string }>(
        `select group_id from ${GROUPS} where catalog_version > 7 order by catalog_version`
      );
      expect(changed).toEqual([{ group_id: 'deleted' }, { group_id: 'new' }]);
    } finally {
      await db.destroy();
    }
  });
});
