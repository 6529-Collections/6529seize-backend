import 'reflect-metadata';
import { EntityManager } from 'typeorm';
import * as db from '@/db';
import * as Entities from '@/entities/entities';
import { SUBSCRIPTION_DEFERRED_WRITES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  deferralReason,
  deferSubscriptionWrites,
  executorSink
} from './subscription-deferred-writes';

// An obviously fake one-wallet key, which fits every subscription table.
const KEY = '0x00000000000000000000000000000000000000a1';

/** Queues a write for KEY on its own connection, committed at once. */
function queueWriteForKey(dedupe: string) {
  return deferSubscriptionWrites(
    [
      {
        kind: 'LOG',
        consolidationKey: KEY,
        dedupe,
        payload: { consolidation_key: KEY, log: dedupe },
        reason: { narrow: [], pendingEarlier: true }
      }
    ],
    executorSink()
  );
}

/**
 * Runs `body` in a transaction on a TypeORM query runner, as the loops'
 * writers do, after one plain read has fixed the transaction's snapshot.
 */
async function inWriterTransaction(
  body: (manager: EntityManager) => Promise<void>
) {
  const runner = db.getDataSource().createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query(
      `SELECT COUNT(*) AS count FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}`
    );
    await body(runner.manager);
  } finally {
    await runner.rollbackTransaction();
    await runner.release();
  }
}

/** Whether MySQL shows a transaction waiting for a row lock. */
async function someoneIsWaiting(): Promise<boolean> {
  // MySQL refreshes innodb_trx only when it was last read over 0.1 s ago,
  // so a faster poll keeps reading the same stale rows.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const [row] = await sqlExecutor.execute<{ count: number }>(
    `SELECT COUNT(*) AS count FROM information_schema.innodb_trx
      WHERE trx_state = 'LOCK WAIT'`
  );
  return Number(row.count) > 0;
}

beforeAll(async () => {
  expect(process.env.DB_HOST).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(process.env.DB_NAME).toMatch(/_jest_worker_\d+$/);
  await db.connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never,
    false,
    { database: process.env.DB_NAME!, failOnInitializationError: true }
  );
});

afterAll(async () => {
  if (db.getDataSource()?.isInitialized) await db.disconnect();
});

describeWithSeed('Real MySQL: the pending-write check in a writer', [], () => {
  it('sees a write queued for the key after the writer took its snapshot', async () => {
    await inWriterTransaction(async (manager) => {
      await queueWriteForKey('queued-after-the-snapshot');

      // Without FOR SHARE the check reads the snapshot, finds nothing
      // waiting, and the writer would go ahead of the queued write.
      expect(await deferralReason(KEY, manager)).toEqual({
        narrow: [],
        pendingEarlier: true
      });
    });
  });

  it('holds a new entry for the key back until the writer that found none is done', async () => {
    let queued = false;
    let queuing: Promise<void> | undefined;
    await inWriterTransaction(async (manager) => {
      expect(await deferralReason(KEY, manager)).toBeNull();

      // Another process queues a write for the key while the writer, which
      // found nothing waiting, has not committed its own write yet.
      queuing = queueWriteForKey('queued-during-the-writer').then(() => {
        queued = true;
      });
      let waiting = false;
      for (let i = 0; i < 40 && !waiting && !queued; i++) {
        waiting = await someoneIsWaiting();
      }
      // Without FOR SHARE the entry goes in at once, ahead of the write the
      // writer is about to make directly, which would then be applied first.
      expect(queued).toBe(false);
      expect(waiting).toBe(true);
    });
    await queuing;
    expect(queued).toBe(true);
    const [row] = await sqlExecutor.execute<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}`
    );
    expect(Number(row.count)).toBe(1);
  });
});
