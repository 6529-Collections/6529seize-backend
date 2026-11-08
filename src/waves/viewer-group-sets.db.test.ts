import 'reflect-metadata';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import {
  VIEWER_GROUP_SET_MEMBERS_TABLE,
  VIEWER_GROUP_SETS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { Time } from '@/time';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import {
  deleteUnusedViewerGroupSets,
  storeViewerGroupSet,
  viewerGroupSetHash,
  viewerGroupSets
} from '@/waves/viewer-group-sets';

const MEMBER = 'vgs-member-group';
const filler = Array.from(
  { length: 350 },
  (_, i) => `vgs-filler-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const groups = [MEMBER, ...filler];
const waves = [
  aWave({}, { id: 'vgs-public', serial_no: 1, name: 'Public' }),
  aWave(
    { visibility_group_id: MEMBER },
    { id: 'vgs-member', serial_no: 2, name: 'Member' }
  ),
  aWave(
    { visibility_group_id: 'vgs-other-group' },
    { id: 'vgs-other', serial_no: 3, name: 'Other' }
  )
];
const FLAG = 'FEATURE_VIEWER_GROUP_SET_TABLE';

describeWithSeed('viewer group sets', withWaves(waves), () => {
  const statements: string[] = [];
  const read = async () => {
    const repo = new WavesApiDb(() => sqlExecutor);
    const db = (repo as unknown as { db: typeof sqlExecutor }).db;
    const original = db.execute.bind(db);
    statements.length = 0;
    jest.spyOn(db, 'execute').mockImplementation((sql, params, opts) => {
      if (sql.includes('wi_viewer_groups as (')) statements.push(sql);
      return original(sql, params, opts);
    });
    try {
      const found = await repo.findWavesByIds(
        waves.map((it) => it.id),
        groups
      );
      return found.map((it) => it.id).sort();
    } finally {
      jest.restoreAllMocks();
    }
  };

  beforeEach(() => {
    process.env[FLAG] = 'true';
    resetViewerGroupsCteSupport(true);
    viewerGroupSets.reset();
  });
  afterEach(() => {
    delete process.env[FLAG];
    resetViewerGroupsCteSupport();
    viewerGroupSets.reset();
  });

  it('reads a stored set by hash and returns what the JSON copy does', async () => {
    const json = await read();
    expect(statements.every((sql) => sql.includes('json_table'))).toBe(true);
    expect(json).toEqual(['vgs-member', 'vgs-public']);
    await storeViewerGroupSet(sqlExecutor, groups);
    viewerGroupSets.reset();
    expect(await read()).toEqual(json);
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      expect(sql).toContain(VIEWER_GROUP_SET_MEMBERS_TABLE);
      expect(sql).not.toContain('json_table');
    }
  });

  it('falls back to the JSON copy while the header is missing where it reads', async () => {
    // Members without a header: an incomplete or not-yet-replicated set.
    const hash = viewerGroupSetHash(groups);
    await storeViewerGroupSet(sqlExecutor, groups);
    await sqlExecutor.execute(
      `delete from ${VIEWER_GROUP_SETS_TABLE} where set_hash = :hash`,
      { hash }
    );
    expect(await read()).toEqual(['vgs-member', 'vgs-public']);
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql).toContain('json_table');
  });

  it('stores a set idempotently, with its header last', async () => {
    const hash = await storeViewerGroupSet(sqlExecutor, [...groups].reverse());
    expect(await storeViewerGroupSet(sqlExecutor, groups)).toBe(hash);
    const [header] = await sqlExecutor.execute<{ group_count: number }>(
      `select group_count from ${VIEWER_GROUP_SETS_TABLE} where set_hash = :hash`,
      { hash }
    );
    expect(Number(header.group_count)).toBe(groups.length);
    const [members] = await sqlExecutor.execute<{ n: number }>(
      `select count(*) as n from ${VIEWER_GROUP_SET_MEMBERS_TABLE} where set_hash = :hash`,
      { hash }
    );
    expect(Number(members.n)).toBe(groups.length);
  });

  it('deletes only sets unused for 14 days, header and members together', async () => {
    const now = Time.currentMillis();
    const stale = await storeViewerGroupSet(
      sqlExecutor,
      groups,
      now - Time.days(15).toMillis()
    );
    const fresh = await storeViewerGroupSet(
      sqlExecutor,
      [MEMBER, ...filler.slice(1)],
      now - Time.days(13).toMillis()
    );
    expect(await deleteUnusedViewerGroupSets(sqlExecutor, { now })).toBe(1);
    const left = async (table: string) =>
      (
        await sqlExecutor.execute<{ set_hash: string }>(
          `select distinct set_hash from ${table}`
        )
      )
        .map((it) => it.set_hash)
        .sort();
    expect(await left(VIEWER_GROUP_SETS_TABLE)).toEqual([fresh]);
    expect(await left(VIEWER_GROUP_SET_MEMBERS_TABLE)).toEqual([fresh]);
    expect([stale, fresh]).toHaveLength(2);
  });
});
