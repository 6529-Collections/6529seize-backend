import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import { DROPS_TABLE } from '@/constants';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { AuthenticationContext } from '@/auth-context';
import { dropsService } from '@/api/drops/drops.api.service';
import { reactionsService } from '@/api/drops/reactions.service';
import {
  runWriteTransaction,
  withRequestDeadline,
  WriteBusyException
} from '@/api/write-transaction-budget';

/**
 * API write transactions run with an execution budget inside a request:
 * lock waits give up after 10 s, the request deadline (5 s before the
 * Lambda's) rolls the transaction back, and both answer 503 + Retry-After.
 */

const wave = aWave(
  { type: WaveType.CHAT, chat_enabled: true },
  { id: 'budget-wave', name: 'Budget wave' }
);
const author = 'budget-author';
const reactor = 'budget-reactor';

function chatDrop(content: string): CreateOrUpdateDropModel {
  return {
    drop_id: null,
    wave_id: wave.id,
    author_id: author,
    author_identity: author,
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

async function threadIdOf(connection: ConnectionWrapper<unknown>) {
  const row = await sqlExecutor.oneOrNull<{ id: number | string }>(
    'select connection_id() as id',
    undefined,
    { wrappedConnection: connection }
  );
  return Number(row?.id);
}

/**
 * Resolves with how long the server took to end `threadId`'s transaction.
 * A connection destroyed in the middle of a lock wait is noticed by the
 * server only when that wait ends: at most the 10 s lock-wait limit.
 */
async function untilNoOpenTransaction(threadId: number): Promise<number> {
  const started = performance.now();
  while ((await openTransactionsOf(threadId)) > 0) {
    if (performance.now() - started > 12_000) {
      throw new Error('the transaction stayed open');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return performance.now() - started;
}

async function openTransactionsOf(threadId: number): Promise<number> {
  const row = await sqlExecutor.oneOrNull<{ n: number | string }>(
    `select count(*) as n from information_schema.innodb_trx
     where trx_mysql_thread_id = :threadId`,
    { threadId }
  );
  return Number(row?.n ?? 0);
}

/** Holds a row lock on the wave row until `release` is called. */
function holdWaveRow() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const isLocked = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const done = sqlExecutor.executeNativeQueriesInTransaction(
    async (connection) => {
      await sqlExecutor.execute(
        'select id from waves where id = :id for update',
        { id: wave.id },
        { wrappedConnection: connection }
      );
      locked();
      await released;
    }
  );
  return { isLocked, release, done };
}

/** A budgeted write that waits for the wave row. */
function budgetedWaveRowWrite(
  remainingMillis: number,
  threadIds: number[]
): Promise<void> {
  return withRequestDeadline(remainingMillis, () =>
    runWriteTransaction((options) =>
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        threadIds.push(await threadIdOf(connection));
        await sqlExecutor.execute(
          'select id from waves where id = :id for update',
          { id: wave.id },
          { wrappedConnection: connection }
        );
      }, options)
    )
  );
}

describeWithSeed('API write transaction budget', [withWaves([wave])], () => {
  it('runs a real post and a real reaction under the budget', async () => {
    const result = await withRequestDeadline(30_000, () =>
      runWriteTransaction((options) =>
        sqlExecutor.executeNativeQueriesInTransaction(
          (connection) =>
            createOrUpdateDrop.execute(chatDrop('budgeted post'), false, {
              connection,
              prePublication: { trustedSystem: true }
            }),
          options
        )
      )
    );
    const stored = await sqlExecutor.oneOrNull<{ id: string }>(
      `select id from ${DROPS_TABLE} where id = :id`,
      { id: result.drop_id }
    );
    expect(stored?.id).toBe(result.drop_id);

    const reacted = await withRequestDeadline(30_000, () =>
      reactionsService.addReaction(result.drop_id, reactor, ':fire:', {
        authenticationContext: AuthenticationContext.fromProfileId(reactor)
      })
    );
    expect(reacted.id).toBe(result.drop_id);
  });

  it('reads back the same drop after commit as inside the transaction', async () => {
    let inside: unknown;
    const result = await sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        const created = await createOrUpdateDrop.execute(
          chatDrop('read back'),
          false,
          { connection, prePublication: { trustedSystem: true } }
        );
        inside = await dropsService.findDropByIdOrThrow(
          { dropId: created.drop_id, skipEligibilityCheck: true },
          {
            connection,
            authenticationContext: AuthenticationContext.fromProfileId(author)
          }
        );
        return created;
      }
    );
    const after = await sqlExecutor.executeNativeQueriesInTransaction(
      (connection) =>
        dropsService.findDropByIdOrThrow(
          { dropId: result.drop_id, skipEligibilityCheck: true },
          {
            connection,
            authenticationContext: AuthenticationContext.fromProfileId(author)
          }
        )
    );
    expect(after).toEqual(inside);
  });

  it('gives up a lock wait after 10 s with 503 + Retry-After and leaves no open transaction', async () => {
    const holder = holdWaveRow();
    await holder.isLocked;
    const threadIds: number[] = [];
    const started = performance.now();
    try {
      const error = await budgetedWaveRowWrite(30_000, threadIds).catch(
        (e: unknown) => e
      );
      const waited = performance.now() - started;
      expect(error).toBeInstanceOf(WriteBusyException);
      expect((error as WriteBusyException).getStatusCode()).toBe(503);
      expect((error as WriteBusyException).retryAfterSeconds).toBe(2);
      expect(waited).toBeGreaterThanOrEqual(9_500);
      expect(waited).toBeLessThan(14_000);
      expect(await openTransactionsOf(threadIds[0])).toBe(0);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  it('rolls the transaction back at the request deadline with 503', async () => {
    const holder = holdWaveRow();
    await holder.isLocked;
    const threadIds: number[] = [];
    const started = performance.now();
    try {
      // 8 s left in the Lambda: the write deadline is 3 s away, well
      // before the 10 s lock wait would give up.
      const error = await budgetedWaveRowWrite(8_000, threadIds).catch(
        (e: unknown) => e
      );
      const waited = performance.now() - started;
      expect(error).toBeInstanceOf(WriteBusyException);
      expect(waited).toBeLessThan(5_000);
      // The connection was cut off mid lock wait (no KILL): the server
      // ends its transaction within the 10 s lock-wait limit.
      expect(await untilNoOpenTransaction(threadIds[0])).toBeLessThan(10_500);
    } finally {
      holder.release();
      await holder.done;
    }
  });

  it('answers at once when the deadline has already passed', async () => {
    await expect(
      withRequestDeadline(5_500, () =>
        runWriteTransaction(() => Promise.resolve('never'))
      )
    ).rejects.toBeInstanceOf(WriteBusyException);
  });

  it('leaves transactions outside a request unbudgeted', async () => {
    const options: unknown[] = [];
    await runWriteTransaction(async (o) => {
      options.push(o);
    });
    expect(options).toEqual([undefined]);
  });
});
