import 'reflect-metadata';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import {
  MirrorRatingEventSource,
  RATING_EVENTS_SETTLE_MS
} from './identity-ratings-feed';

// The feed's queries against the identity mirror's table. The table comes
// with the mirror; where it is not there yet, the test makes it with the
// columns the feed reads.
const TABLE = 'identity_chain_rating_events';

describe('identity_chain_rating_events reads', () => {
  const source = new MirrorRatingEventSource(() => sqlExecutor);
  let created = false;

  // The test database's pool lives for one test, so the table is made and
  // dropped around each.
  beforeEach(async () => {
    const existing = await sqlExecutor.execute(`show tables like '${TABLE}'`);
    created = !existing.length;
    if (created) {
      await sqlExecutor.execute(`
        create table ${TABLE} (
          id bigint not null auto_increment primary key,
          height bigint not null,
          block_time_ms bigint not null,
          rater_principal varchar(66) not null,
          rater_profile_id varchar(50) null,
          target_principal varchar(66) not null,
          target_profile_id varchar(50) null,
          matter varchar(50) not null,
          matter_category varchar(100) not null,
          old_rating int not null,
          new_rating int not null,
          total_after bigint not null,
          origin varchar(16) not null,
          by_import tinyint(1) not null,
          source varchar(20) not null,
          created_at bigint not null
        )`);
    }
    await sqlExecutor.execute(`delete from ${TABLE}`);
  });
  afterEach(async () => {
    if (created) await sqlExecutor.execute(`drop table ${TABLE}`);
  });

  const insert = async (
    rows: { origin: string; byImport?: boolean; ageMs?: number }[]
  ): Promise<number[]> => {
    const ids: number[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      await sqlExecutor.execute(
        `insert into ${TABLE} (height, block_time_ms, rater_principal,
           rater_profile_id, target_principal, target_profile_id, matter,
           matter_category, old_rating, new_rating, total_after, origin,
           by_import, source, created_at)
         values (:height, :time, :rater, 'rater', :target, 'target', 'REP',
           'Art', 0, 1, 1, :origin, :byImport, 'FEED', :createdAt)`,
        {
          height: 100 - index,
          time: 1_795_000_000_000 + index,
          rater: `0x${String(index).padStart(40, '0')}`,
          target: `0x${'a'.repeat(40)}`,
          origin: row.origin,
          byImport: row.byImport ?? false,
          createdAt:
            Time.currentMillis() - (row.ageMs ?? RATING_EVENTS_SETTLE_MS + 1)
        }
      );
      const [last] = await sqlExecutor.execute<{ id: number }>(
        `select max(id) as id from ${TABLE}`
      );
      ids.push(Number(last.id));
    }
    return ids;
  };

  it('scans settled rows in id order, a span at a time', async () => {
    const ids = await insert([
      { origin: 'OPERATION' },
      { origin: 'IMPORT', byImport: true },
      { origin: 'CAP_CUT' },
      { origin: 'OPERATION', ageMs: 0 }
    ]);
    expect(await source.scanEnd(0, 2)).toEqual({ id: ids[1], height: 99 });
    // The last row is not settled yet.
    expect(await source.scanEnd(ids[1], 10)).toEqual({
      id: ids[2],
      height: 98
    });
    expect(await source.scanEnd(ids[2], 10)).toBeNull();
  });

  it('reads only the rows that can notify, in id order, with every column', async () => {
    const ids = await insert([
      { origin: 'OPERATION' },
      { origin: 'IMPORT', byImport: true },
      { origin: 'OPERATION', byImport: true },
      { origin: 'CAP_CUT' },
      { origin: 'UNKNOWN' },
      { origin: 'OPERATION' }
    ]);
    const rows = await source.readNotifying(0, ids[5], 10);
    expect(rows.map((row) => row.id)).toEqual([ids[0], ids[5]]);
    expect(rows[1]).toEqual({
      id: ids[5],
      height: 95,
      block_time_ms: 1_795_000_000_005,
      rater_principal: `0x${'5'.padStart(40, '0')}`,
      target_principal: `0x${'a'.repeat(40)}`,
      rater_profile_id: 'rater',
      target_profile_id: 'target',
      matter: 'REP',
      matter_category: 'Art',
      old_rating: 0,
      new_rating: 1,
      total_after: 1,
      origin: 'OPERATION',
      by_import: false,
      created_at: expect.any(Number)
    });
    expect(await source.readNotifying(ids[0], ids[4], 10)).toEqual([]);
    expect(
      (await source.readByIds([ids[5], ids[1]])).map((row) => row.id)
    ).toEqual([ids[1], ids[5]]);
    expect(await source.heightOf(ids[5])).toBe(95);
    expect(await source.heightOf(ids[5] + 1000)).toBeNull();
  });
});
