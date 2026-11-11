import 'reflect-metadata';
import { METRIC_ROLLUP_HOUR_TABLE } from '@/constants';
import { inSequence } from '@/db/in-sequence';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

/**
 * Statements on one transaction connection: with Promise.all a failure
 * leaves the other tasks running, and their later statements reach the
 * connection after the ROLLBACK, so they commit on their own. inSequence
 * stops at the first failure.
 */

function insertRow(scope: string, connection: ConnectionWrapper<unknown>) {
  return sqlExecutor.execute(
    `insert into ${METRIC_ROLLUP_HOUR_TABLE}
       (hour_start, metric, scope, key1, key2, event_count, value_sum)
     values (utc_timestamp(), 'TEST', :scope, '', '', 1, 1)`,
    { scope },
    { wrappedConnection: connection }
  );
}

async function scopes(): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ scope: string }>(
    `select scope from ${METRIC_ROLLUP_HOUR_TABLE} where metric = 'TEST' order by scope`
  );
  return rows.map((row) => row.scope);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeWithSeed('inSequence on a transaction connection', [], () => {
  it('Promise.all lets a later write commit after the transaction rolled back', async () => {
    let lateWrite: Promise<unknown> = Promise.resolve();
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        await Promise.all([
          (async () => {
            await insertRow('first', connection);
            throw new Error('a step failed');
          })(),
          (async () => {
            // A second step of another task, reached after the failure.
            await sleep(200);
            lateWrite = insertRow('late', connection);
            await lateWrite;
          })()
        ]);
      })
    ).rejects.toThrow('a step failed');
    await sleep(400);
    await lateWrite;
    // The failed transaction's own write is gone, but the late one committed.
    expect(await scopes()).toEqual(['late']);
  });

  it('inSequence stops at the first failure and the whole transaction rolls back', async () => {
    const ran: string[] = [];
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        inSequence([
          async () => {
            ran.push('first');
            await insertRow('first', connection);
            throw new Error('a step failed');
          },
          async () => {
            ran.push('late');
            await insertRow('late', connection);
          }
        ])
      )
    ).rejects.toThrow('a step failed');
    await sleep(400);
    expect(ran).toEqual(['first']);
    expect(await scopes()).toEqual([]);
  });

  it('returns the results in order', async () => {
    const order: number[] = [];
    const results = await inSequence(
      [3, 1, 2].map((delay) => async () => {
        await sleep(delay * 20);
        order.push(delay);
        return delay * 10;
      })
    );
    expect(order).toEqual([3, 1, 2]);
    expect(results).toEqual([30, 10, 20]);
  });
});
