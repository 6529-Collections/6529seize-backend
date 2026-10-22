import { DataSource, QueryRunner } from 'typeorm';
import * as registered from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { nativeOriginalPrimaryFixture } from '@/tests/fixtures/native-competition.fixture';
import {
  installHistoricalCompetitionFixture,
  removeHistoricalCompetitionFixture
} from '@/tests/fixtures/retained-competition.fixture';
import { installLegacyCompetitionGetFacade } from './legacy-competition-get-facade';
import {
  assertCompetitionSchemaSyncSafe,
  RETIRED_COMPETITION_TABLES
} from './retired-competition-storage';
import {
  cleanupDigest,
  DELETED_WAVE_COMPETITION_ORPHANS,
  deleteCompetitionOrphans,
  dropCompetitionStorage,
  inspectCompetitionOrphans,
  inspectCompetitionStorage,
  prepareCompetitionStorage
} from './competition-storage-cleanup';
import { WaveType } from '@/entities/IWave';

describe('guarded physical competition storage cleanup', () => {
  let source: DataSource;
  let runner: QueryRunner;

  beforeAll(async () => {
    source = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      entities: Object.values(registered).filter(
        (value) => typeof value === 'function'
      ),
      synchronize: false
    });
    await source.initialize();
    runner = source.createQueryRunner('master');
  });

  beforeEach(async () => {
    await installHistoricalCompetitionFixture();
    await resetTestDatabase();
    await installLegacyCompetitionGetFacade(sqlExecutor);
  });

  afterEach(async () => {
    await runner.query('drop view if exists cleanup_unexpected_reader');
    await runner.query('drop trigger if exists cleanup_unexpected_capture');
    await removeHistoricalCompetitionFixture();
    await source.synchronize();
    await installLegacyCompetitionGetFacade(sqlExecutor);
    await resetTestDatabase();
  });

  afterAll(async () => {
    await runner.release();
    await source.destroy();
  });

  async function seedOrphan() {
    const orphan = DELETED_WAVE_COMPETITION_ORPHANS[0];
    const wave = aWave(
      { type: WaveType.APPROVE },
      { id: orphan.wave, serial_no: 1, name: 'Deleted original' }
    );
    const native = nativeOriginalPrimaryFixture(wave);
    const record = {
      ...native,
      id: orphan.competition,
      storage_mode: 'LEGACY_ADAPTER'
    };
    const serialized = Object.fromEntries(
      Object.entries(record).map(([key, value]) => [
        key,
        value !== null && typeof value === 'object'
          ? JSON.stringify(value)
          : value
      ])
    );
    await sqlExecutor.bulkInsert(
      'competitions',
      [serialized],
      Object.keys(serialized)
    );
    await runner.query(
      "insert into competition_config_versions(competition_id,version,config,created_by,created_at) values (?,1,'{}','fixture',1)",
      [orphan.competition]
    );
    await runner.query(
      'insert into wave_dropper_metrics(wave_id,dropper_id,drops_count,latest_drop_timestamp,participatory_drops_count) values (?,?,1,1,1)',
      [orphan.wave, 'retained-author']
    );
    await runner.query(
      'insert into wave_reader_metrics(wave_id,reader_id,latest_read_timestamp) values (?,?,1)',
      [orphan.wave, 'retained-reader']
    );
    await runner.query(
      "insert into deleted_drops(id,wave_id,author_id,created_at,deleted_at) values ('retained-deletion',?,'retained-author',1,2)",
      [orphan.wave]
    );
    await runner.query(
      "insert into profile_activity_logs(id,profile_id,competition_id,contents,type,additional_data_1) values ('retained-activity','retained-author',?,'{}','DROP_VOTE_EDIT',?)",
      [orphan.competition, orphan.wave]
    );
    await runner.query(
      "insert into waves_archive(id,serial_no,name,description_drop_id,created_by,created_at,archival_entry_created_at) values (?,1,'Deleted original','description','retained-author',1,2)",
      [orphan.wave]
    );
    return { orphan, wave };
  }

  it('makes physical deletion explicit, preserves native hub metadata and permits full synchronization without recreation', async () => {
    await runner.query(
      "insert into waves(id,name,description_drop_id,created_by,created_at,hub_participation_config,hub_voting_config) values ('live-hub','Live','description','author',1,JSON_OBJECT('terms','shared terms'),JSON_OBJECT('decision_strategy',JSON_OBJECT('first_decision_time',1,'subsequent_decisions',JSON_ARRAY(),'is_rolling',true)))"
    );
    await runner.query(
      'create index idx_wave_voting_group_id on waves(voting_group_id)'
    );
    const before = await runner.query(
      "select hub_participation_config,hub_voting_config from waves where id='live-hub'"
    );
    await expect(assertCompetitionSchemaSyncSafe(sqlExecutor)).rejects.toThrow(
      'explicit backed-up operator cleanup'
    );
    const inventory = await inspectCompetitionStorage(runner);
    expect(inventory.tables.length).toBe(21);
    const result = await dropCompetitionStorage(runner, inventory);
    expect(result.tables).toHaveLength(21);
    await expect(
      assertCompetitionSchemaSyncSafe(sqlExecutor)
    ).resolves.toBeUndefined();
    await source.synchronize();
    await installLegacyCompetitionGetFacade(sqlExecutor);
    expect((await inspectCompetitionStorage(runner)).tables).toEqual([]);
    expect((await inspectCompetitionStorage(runner)).columns).toEqual([]);
    await expect(prepareCompetitionStorage(runner)).resolves.toBeUndefined();
    await expect(
      dropCompetitionStorage(runner, await inspectCompetitionStorage(runner))
    ).resolves.toEqual({ tables: [], columns: [] });
    expect(
      (await inspectCompetitionOrphans(runner)).every(
        ({ rows }) => rows.length === 0
      )
    ).toBe(true);
    expect(
      await runner.query(
        "select hub_participation_config,hub_voting_config from waves where id='live-hub'"
      )
    ).toEqual(before);
  });

  it('rejects an unexpected physical view dependency before any deletion', async () => {
    await runner.query(
      'create view cleanup_unexpected_reader as select drop_id from drop_voter_states'
    );
    const inventory = await inspectCompetitionStorage(runner);
    await expect(dropCompetitionStorage(runner, inventory)).rejects.toThrow(
      'physical dependencies'
    );
    expect(
      (await inspectCompetitionStorage(runner)).tables.map(({ name }) => name)
    ).toEqual(inventory.tables.map(({ name }) => name));
  });

  it('rejects an old compatibility view that still reads physical wave columns', async () => {
    await runner.query(
      'create or replace view legacy_get_waves as select w.* from waves w'
    );
    const inventory = await inspectCompetitionStorage(runner);
    await expect(dropCompetitionStorage(runner, inventory)).rejects.toThrow(
      'native compatibility views'
    );
    expect((await inspectCompetitionStorage(runner)).tables).toHaveLength(21);
  });

  it('rejects renamed physical wave aliases inside an otherwise native compatibility view', async () => {
    await runner.query(
      'create or replace view legacy_get_waves as select another_alias.*,c.id as competition_id from waves another_alias join competitions c on c.wave_id=another_alias.id'
    );
    const inventory = await inspectCompetitionStorage(runner);
    await expect(dropCompetitionStorage(runner, inventory)).rejects.toThrow(
      'native compatibility views'
    );
    expect((await inspectCompetitionStorage(runner)).columns).toEqual(
      inventory.columns
    );
  });

  it('rejects a newly introduced trigger on shared storage before deleting its columns', async () => {
    await runner.query(
      'create trigger cleanup_unexpected_capture before update on waves for each row set NEW.type=OLD.type'
    );
    const inventory = await inspectCompetitionStorage(runner);
    await expect(dropCompetitionStorage(runner, inventory)).rejects.toThrow(
      'physical dependencies'
    );
    expect((await inspectCompetitionStorage(runner)).tables).toHaveLength(21);
  });

  it('rejects a newly discovered view of a retired shared column', async () => {
    await runner.query(
      'create view cleanup_unexpected_reader as select type from waves'
    );
    const inventory = await inspectCompetitionStorage(runner);
    await expect(dropCompetitionStorage(runner, inventory)).rejects.toThrow(
      'unreviewed view'
    );
  });

  it('rejects changed inert data before any DDL', async () => {
    const inventory = await inspectCompetitionStorage(runner);
    await runner.query(
      "insert into drop_voter_states(voter_id,drop_id,votes,wave_id) values ('voter','changed',9,'wave')"
    );
    await expect(dropCompetitionStorage(runner, inventory)).rejects.toThrow(
      'inventory changed'
    );
    expect((await inspectCompetitionStorage(runner)).tables).toHaveLength(21);
  });

  it('removes only the reviewed obsolete orphan rows and retains shared deletion history', async () => {
    const { orphan } = await seedOrphan();
    const shared = await runner.query(
      'select * from deleted_drops where wave_id=?',
      [orphan.wave]
    );
    const retainedActivity = await runner.query(
      'select * from profile_activity_logs where competition_id=?',
      [orphan.competition]
    );
    const retainedArchive = await runner.query(
      'select * from waves_archive where id=?',
      [orphan.wave]
    );
    const inventory = await inspectCompetitionOrphans(runner);
    const result = await deleteCompetitionOrphans(runner, inventory);
    expect(result.filter(({ deleted }) => deleted > 0)).toEqual([
      { table: 'competition_config_versions', deleted: 1 },
      { table: 'wave_dropper_metrics', deleted: 1 },
      { table: 'wave_reader_metrics', deleted: 1 },
      { table: 'competitions', deleted: 1 }
    ]);
    expect(
      await runner.query('select * from deleted_drops where wave_id=?', [
        orphan.wave
      ])
    ).toEqual(shared);
    expect(
      (await inspectCompetitionOrphans(runner)).every(
        ({ rows }) => rows.length === 0
      )
    ).toBe(true);
    expect(
      await runner.query(
        'select * from profile_activity_logs where competition_id=?',
        [orphan.competition]
      )
    ).toEqual(retainedActivity);
    expect(
      await runner.query('select * from waves_archive where id=?', [
        orphan.wave
      ])
    ).toEqual(retainedArchive);
    await prepareCompetitionStorage(runner);
    const [column] = await runner.query(
      "show columns from competitions like 'storage_mode'"
    );
    expect(column.Default).toBe('NATIVE');
  });

  it('fails closed when an orphan acquires native membership or changes mapping', async () => {
    const { orphan } = await seedOrphan();
    const original = await inspectCompetitionOrphans(runner);
    await runner.query(
      "update competitions set wave_id='another-wave',legacy_wave_id='another-wave' where id=?",
      [orphan.competition]
    );
    await expect(deleteCompetitionOrphans(runner, original)).rejects.toThrow(
      'immutable mapping'
    );
    expect(
      await runner.query('select id from competitions where id=?', [
        orphan.competition
      ])
    ).toHaveLength(1);
  });

  it('rejects newly discovered native references before taking obsolete owner locks', async () => {
    const { orphan } = await seedOrphan();
    await runner.query(
      "insert into competition_votes(id,competition_id,entry_id,voter_profile_id,value,credit_spent,created_at,updated_at) values ('unexpected',?,'entry','voter',1,1,1,1)",
      [orphan.competition]
    );
    await expect(inspectCompetitionOrphans(runner)).rejects.toThrow(
      'Unexpected orphan references in competition_votes'
    );
  });

  it('stops on a short metadata lock wait without falling back to blocking DDL', async () => {
    const inventory = await inspectCompetitionStorage(runner);
    const blocker = source.createQueryRunner('master');
    await blocker.startTransaction();
    try {
      await blocker.query('select id from waves limit 1');
      await expect(dropCompetitionStorage(runner, inventory)).rejects.toThrow(
        'Lock wait timeout'
      );
      expect((await inspectCompetitionStorage(runner)).tables).toHaveLength(21);
    } finally {
      await blocker.rollbackTransaction();
      await blocker.release();
    }
  });

  it('protects a historical orphan winner that acquires a current card mapping', async () => {
    await seedOrphan();
    await runner.query(
      "insert into meme_card_drop_mappings(meme_card_id,drop_id) values (1,'3e6067d1-51ff-4909-9e5f-28c69e486af4')"
    );
    await expect(inspectCompetitionOrphans(runner)).rejects.toThrow(
      'current claims, card ownership or native membership'
    );
  });

  it('keeps an exact snapshot identity digest sensitive to count, data and schema drift', async () => {
    const first = await inspectCompetitionStorage(runner);
    const second = await inspectCompetitionStorage(runner);
    expect(cleanupDigest(second)).toBe(cleanupDigest(first));
    expect(RETIRED_COMPETITION_TABLES).toContain('drop_real_vote_in_time_xxx');
  });
});
