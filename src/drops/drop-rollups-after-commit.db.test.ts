import 'reflect-metadata';
import {
  DROPS_TABLE,
  METRIC_ROLLUP_HOUR_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE
} from '@/constants';
import { dropsDb } from '@/drops/drops.db';
import { waveDropMetricsRefreshService } from '@/drops/wave-drop-metrics-refresh.service';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { MetricRollupHourMetric } from '@/entities/IMetricRollupHour';
import { WaveType } from '@/entities/IWave';
import { metricsDb } from '@/metrics/MetricsDb';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';

/**
 * Prod, 2026-11-07 19:00: posts failed with ER_LOCK_DEADLOCK while waiting
 * 10-15 s to upsert the hour's DROP/global row in metric_rollup_hour. Every
 * post upserted that row inside its transaction and held the lock until it
 * committed, so posts on the whole platform queued behind each other on it,
 * each still holding its earlier locks. Rollups now run after commit, one
 * autocommit statement each, so a post transaction never holds DROP/global.
 *
 * Prod, 2026-11-07 20:20: a post waited 30 s for its wave's wave_metrics row
 * (every post in a wave updates it) and every later post queued behind it.
 * The created-drop wave counters now also run after commit.
 */

const wave = aWave(
  { type: WaveType.CHAT, chat_enabled: true },
  { id: 'rollup-wave', name: 'Rollup wave' }
);
const authors = ['rollup-author-a', 'rollup-author-b'];

function chatDrop(authorId: string, content: string): CreateOrUpdateDropModel {
  return {
    drop_id: null,
    wave_id: wave.id,
    author_id: authorId,
    author_identity: authorId,
    drop_type: DropType.CHAT,
    signature: null,
    title: null,
    reply_to: null,
    parts: [{ content, quoted_drop: null, media: [] }],
    metadata: [],
    mentioned_users: [],
    mentioned_waves: [],
    mentioned_groups: [],
    referenced_nfts: [],
    is_additional_action_promised: null
  };
}

function post(model: CreateOrUpdateDropModel) {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    createOrUpdateDrop.execute(model, false, {
      connection,
      prePublication: { trustedSystem: true }
    })
  );
}

async function rollups(): Promise<Record<string, number>> {
  const rows = await sqlExecutor.execute<{
    metric: string;
    scope: string;
    event_count: number | string;
  }>(
    `select metric, scope, sum(event_count) as event_count
     from ${METRIC_ROLLUP_HOUR_TABLE} group by metric, scope`
  );
  return Object.fromEntries(
    rows.map((row) => [`${row.metric}/${row.scope}`, Number(row.event_count)])
  );
}

async function waveCounters() {
  const wave_ = await sqlExecutor.oneOrNull<{ drops_count: number | string }>(
    `select drops_count from ${WAVE_METRICS_TABLE} where wave_id = :waveId`,
    { waveId: wave.id }
  );
  const droppers = await sqlExecutor.execute<{
    dropper_id: string;
    drops_count: number | string;
  }>(
    `select dropper_id, drops_count from ${WAVE_DROPPER_METRICS_TABLE} where wave_id = :waveId order by dropper_id`,
    { waveId: wave.id }
  );
  return {
    wave: wave_ ? Number(wave_.drops_count) : null,
    droppers: Object.fromEntries(
      droppers.map((row) => [row.dropper_id, Number(row.drops_count)])
    )
  };
}

async function threadIdOf(connection: ConnectionWrapper<unknown>) {
  const row = await sqlExecutor.oneOrNull<{ id: number | string }>(
    'select connection_id() as id',
    undefined,
    { wrappedConnection: connection }
  );
  return Number(row?.id);
}

/** Resolves once the transaction on `threadId` is waiting for a row lock. */
async function untilWaitingForALock(threadId: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const trx = await sqlExecutor.oneOrNull<{ trx_state: string }>(
      `select trx_state from information_schema.innodb_trx
       where trx_mysql_thread_id = :threadId`,
      { threadId }
    );
    if (trx?.trx_state === 'LOCK WAIT') return;
    if (Date.now() > deadline) throw new Error('never waited for the lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeWithSeed(
  'Created-drop rollups run after commit',
  [withWaves([wave])],
  () => {
    it('made every other post wait while one post held DROP/global (the old in-transaction rollup)', async () => {
      const upsertDrop = (connection: ConnectionWrapper<unknown>) =>
        metricsDb.upsertMetricRollupHour(
          { metric: MetricRollupHourMetric.DROP, event_count: 1 },
          { connection }
        );
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstHoldsDrop!: () => void;
      const dropHeld = new Promise<void>((resolve) => {
        firstHoldsDrop = resolve;
      });
      let secondThread!: (id: number) => void;
      const secondThreadId = new Promise<number>((resolve) => {
        secondThread = resolve;
      });
      // The first post's rollup, then the rest of its transaction.
      const first = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await upsertDrop(connection);
          firstHoldsDrop();
          await firstMayCommit;
        }
      );
      await dropHeld;
      // Another author's post reaches its rollup meanwhile.
      const second = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          secondThread(await threadIdOf(connection));
          await upsertDrop(connection);
        }
      );
      await untilWaitingForALock(await secondThreadId);
      releaseFirst();
      await Promise.all([first, second]);
      expect((await rollups())[`${MetricRollupHourMetric.DROP}/global`]).toBe(
        2
      );
    });

    it('lets concurrent posts at the start of an hour all succeed with correct counts', async () => {
      const results = await Promise.allSettled([
        post(chatDrop(authors[0], 'first')),
        post(chatDrop(authors[1], 'second')),
        post(chatDrop(authors[0], 'third'))
      ]);
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled'
      ]);
      expect(await rollups()).toEqual({
        [`${MetricRollupHourMetric.ACTIVE_IDENTITY}/${authors[0]}`]: 2,
        [`${MetricRollupHourMetric.ACTIVE_IDENTITY}/${authors[1]}`]: 1,
        [`${MetricRollupHourMetric.DROP}/global`]: 3,
        [`${MetricRollupHourMetric.DROPPER_DROP}/${authors[0]}`]: 2,
        [`${MetricRollupHourMetric.DROPPER_DROP}/${authors[1]}`]: 1
      });
      expect(await waveCounters()).toEqual({
        wave: 3,
        droppers: { [authors[0]]: 2, [authors[1]]: 1 }
      });
    });

    it('records no rollups for a post whose transaction rolls back', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await createOrUpdateDrop.execute(
            chatDrop(authors[0], 'rolled back'),
            false,
            { connection, prePublication: { trustedSystem: true } }
          );
          throw new Error('later step failed');
        })
      ).rejects.toThrow('later step failed');
      expect(await rollups()).toEqual({});
      expect(await waveCounters()).toEqual({ wave: null, droppers: {} });
      const drops = await sqlExecutor.oneOrNull<{ n: number }>(
        `select count(*) as n from ${DROPS_TABLE} where wave_id = :waveId`,
        { waveId: wave.id }
      );
      expect(Number(drops?.n)).toBe(0);
    });

    it('does not hold the DROP/global lock in the post transaction', async () => {
      // While a post's transaction is still open, another session updates
      // DROP/global at once. It used to wait for the post to commit (here
      // that would be the lock wait timeout, since the post waits for it).
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await createOrUpdateDrop.execute(
            chatDrop(authors[0], 'open transaction'),
            false,
            { connection, prePublication: { trustedSystem: true } }
          );
          const started = Date.now();
          await metricsDb.upsertMetricRollupHour(
            { metric: MetricRollupHourMetric.DROP, event_count: 1 },
            {}
          );
          expect(Date.now() - started).toBeLessThan(1_000);
        }
      );
      expect((await rollups())[`${MetricRollupHourMetric.DROP}/global`]).toBe(
        2
      );
    });

    it("does not hold the wave's wave_metrics row in the post transaction", async () => {
      await post(chatDrop(authors[1], 'creates the row'));
      // While another post's transaction is open, a second session updates
      // the same wave's counter row at once.
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await createOrUpdateDrop.execute(
            chatDrop(authors[0], 'open transaction'),
            false,
            { connection, prePublication: { trustedSystem: true } }
          );
          const started = Date.now();
          await dropsDb.applyInsertedDropMetricsDelta(
            {
              wave_id: wave.id,
              author_id: authors[1],
              drop_type: DropType.CHAT
            },
            {}
          );
          expect(Date.now() - started).toBeLessThan(1_000);
        }
      );
      expect(await waveCounters()).toEqual({
        wave: 3,
        droppers: { [authors[0]]: 1, [authors[1]]: 2 }
      });
    });

    it('marks the wave for a recount when the counters cannot be applied', async () => {
      const delta = jest
        .spyOn(dropsDb, 'applyInsertedDropMetricsDelta')
        .mockRejectedValueOnce(
          Object.assign(new Error('lock wait'), {
            code: 'ER_LOCK_WAIT_TIMEOUT'
          })
        );
      const dirty = jest.spyOn(
        waveDropMetricsRefreshService,
        'markWaveDropMetricsDirtyBestEffort'
      );
      try {
        await post(chatDrop(authors[0], 'counter fails'));
        expect(dirty).toHaveBeenCalledWith(
          [wave.id],
          'DROP_CHANGED',
          expect.anything()
        );
        // The post itself succeeded.
        const drops = await sqlExecutor.oneOrNull<{ n: number }>(
          `select count(*) as n from ${DROPS_TABLE} where wave_id = :waveId`,
          { waveId: wave.id }
        );
        expect(Number(drops?.n)).toBe(1);
      } finally {
        delta.mockRestore();
        dirty.mockRestore();
      }
    });
  }
);
