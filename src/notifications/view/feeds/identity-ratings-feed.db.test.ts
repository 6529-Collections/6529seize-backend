import 'reflect-metadata';
import { IDENTITY_CHAIN_RATING_EVENTS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { Time } from '@/time';
import {
  MirrorRatingEventSource,
  RATING_EVENTS_SETTLE_MS
} from './identity-ratings-feed';

// The feed's queries against the identity mirror's table, which the test
// database has from the mirror's entity.
const TABLE = IDENTITY_CHAIN_RATING_EVENTS_TABLE;

describe('identity_chain_rating_events reads', () => {
  const source = new MirrorRatingEventSource(() => sqlExecutor);

  beforeEach(async () => {
    await sqlExecutor.execute(`delete from ${TABLE}`);
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
