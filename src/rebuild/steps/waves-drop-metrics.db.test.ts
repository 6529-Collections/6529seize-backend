import 'reflect-metadata';
import { RebuildContext } from '@/rebuild/manifest.types';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { insertRow } from '@/tests/fixtures/rebuild-rows.fixture';
import { rebuildWavesDropMetrics } from './waves-drop-metrics.steps';

const W1 = 'wave-with-drops';
const W2 = 'wave-with-only-a-deleted-drop';
const W3 = 'wave-never-dropped-in';

async function rows(table: string, key: string) {
  return sqlExecutor.execute<Record<string, unknown>>(
    `select ${key}, drops_count, participatory_drops_count, latest_drop_timestamp
       from ${table} order by ${key}`
  );
}

describeWithSeed('the waves drop metrics rebuild', [], () => {
  beforeEach(async () => {
    const drop = (
      id: string,
      wave: string,
      author: string,
      type: string,
      at: number
    ) =>
      insertRow('drops', {
        id,
        wave_id: wave,
        author_id: author,
        drop_type: type,
        created_at: at
      });
    await drop('d1', W1, 'author-a', 'CHAT', 10);
    await drop('d2', W1, 'author-b', 'PARTICIPATORY', 20);
    await drop('d3', W1, 'author-a', 'WINNER', 30);
    await insertRow('deleted_drops', {
      id: 'd4',
      wave_id: W1,
      author_id: 'author-c',
      created_at: 5,
      deleted_at: 6
    });
    await insertRow('deleted_drops', {
      id: 'd5',
      wave_id: W2,
      author_id: 'author-d',
      created_at: 7,
      deleted_at: 8
    });
    await insertRow('waves', { id: W3 });
  });

  it('recounts every wave and author that has or had a drop, from the drops alone', async () => {
    await rebuildWavesDropMetrics({} as RebuildContext);
    expect(await rows('wave_metrics', 'wave_id')).toEqual([
      {
        wave_id: W1,
        drops_count: 1,
        participatory_drops_count: 1,
        latest_drop_timestamp: 30
      },
      {
        wave_id: W2,
        drops_count: 0,
        participatory_drops_count: 0,
        latest_drop_timestamp: 0
      }
    ]);
    // A deleted drop's author keeps a row of zeros, as 6529.io leaves it.
    const droppers = await sqlExecutor.execute<Record<string, unknown>>(
      `select wave_id, dropper_id, drops_count, participatory_drops_count,
              latest_drop_timestamp
         from wave_dropper_metrics order by wave_id, dropper_id`
    );
    expect(droppers).toEqual([
      {
        wave_id: W1,
        dropper_id: 'author-a',
        drops_count: 1,
        participatory_drops_count: 0,
        latest_drop_timestamp: 30
      },
      {
        wave_id: W1,
        dropper_id: 'author-b',
        drops_count: 0,
        participatory_drops_count: 1,
        latest_drop_timestamp: 20
      },
      {
        wave_id: W1,
        dropper_id: 'author-c',
        drops_count: 0,
        participatory_drops_count: 0,
        latest_drop_timestamp: 0
      },
      {
        wave_id: W2,
        dropper_id: 'author-d',
        drops_count: 0,
        participatory_drops_count: 0,
        latest_drop_timestamp: 0
      }
    ]);
  });

  it("keeps a row's other columns, which their own owners write", async () => {
    await insertRow('wave_metrics', { wave_id: W1, subscribers_count: 7 });
    await rebuildWavesDropMetrics({} as RebuildContext);
    const [row] = await sqlExecutor.execute<{ subscribers_count: number }>(
      `select subscribers_count from wave_metrics where wave_id = :id`,
      { id: W1 }
    );
    expect(Number(row.subscribers_count)).toBe(7);
  });
});
