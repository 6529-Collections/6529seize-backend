import 'reflect-metadata';
import { RequestContext } from '@/request.context';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { SIGNED_RECORD_HEADS_TABLE } from '@/constants';
import {
  RecordChange,
  RecordHeadKey,
  RecordIndexer,
  RecordRegistry,
  RecordRuleError,
  RecordTypeHandler,
  SenderKeyring
} from './record-index';
import { RecordOrderKey } from './record-order';
import { VerifiedRecord } from './record-verify';
import { SignedRecordHeadsDb } from './signed-record-heads.db';

const OWNER = `0x${'0'.repeat(63)}1`;
const key = (rkey: string): RecordHeadKey => ({
  owner: OWNER,
  family: 'ps',
  type: 'follow',
  key: rkey
});
const order = (anchor: number, eventId = `0x${'a'.repeat(64)}`) => ({
  anchor,
  claimedTime: anchor * 10,
  eventId
});

/** A RECORD in ps for one key at a given order, as verify would return it. */
function followRecord(rkey: string, at: RecordOrderKey): VerifiedRecord {
  return {
    event: { id: at.eventId } as VerifiedRecord['event'],
    family: 'ps',
    owner: OWNER,
    principal: OWNER,
    writer: 'author',
    order: at,
    parsed: { kind: 9, type: 'follow', key: rkey, body: {} }
  };
}

/**
 * sqlExecutor with every insert into the heads table held after it returns
 * until a second one has returned too (or a second passes), so two lock()
 * calls hold whatever their insert locked when they reach `for update`.
 */
function executorMeetingAtHeadInsert(): typeof sqlExecutor {
  let finished = 0;
  let bothFinished: () => void = () => undefined;
  const met = new Promise<void>((resolve) => {
    bothFinished = resolve;
  });
  return new Proxy(sqlExecutor, {
    get(target, prop, receiver) {
      if (prop !== 'execute') {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async (...args: Parameters<typeof sqlExecutor.execute>) => {
        const sql = String(args[0]);
        const isHeadInsert =
          /insert/i.test(sql) && sql.includes(SIGNED_RECORD_HEADS_TABLE);
        const result = await target.execute(...args);
        if (isHeadInsert) {
          if (++finished === 2) {
            bothFinished();
          }
          await Promise.race([
            met,
            new Promise((resolve) => setTimeout(resolve, 1000))
          ]);
        }
        return result;
      };
    }
  });
}

describeWithSeed('SignedRecordHeadsDb', [], () => {
  const db = new SignedRecordHeadsDb(() => sqlExecutor);
  const ctx: RequestContext = {};

  it('reads nothing for a new key, then the order it stored', async () => {
    await db.inTransaction(ctx, async (tx) => {
      expect(await db.lock(key('a'), tx)).toBeNull();
      await db.put(key('a'), order(5), tx);
    });
    await db.inTransaction(ctx, async (tx) => {
      expect(await db.lock(key('a'), tx)).toEqual(order(5));
    });
  });

  it('keeps keys apart that differ only in case or accents', async () => {
    await db.inTransaction(ctx, async (tx) => {
      await db.lock(key('mute'), tx);
      await db.put(key('mute'), order(1), tx);
      await db.lock(key('Mute'), tx);
      await db.put(key('Mute'), order(2), tx);
      await db.lock(key('mûte'), tx);
      await db.put(key('mûte'), order(3), tx);
    });
    const rows = await sqlExecutor.execute<{ rkey: string; anchor: number }>(
      `select rkey, anchor from ${SIGNED_RECORD_HEADS_TABLE} order by anchor`
    );
    expect(rows.map((row) => [row.rkey, Number(row.anchor)])).toEqual([
      ['mute', 1],
      ['Mute', 2],
      ['mûte', 3]
    ]);
  });

  it("leaves nothing of a record a rule refuses inside the caller's transaction, which then commits", async () => {
    const handler: RecordTypeHandler = {
      family: 'ps',
      type: 'follow',
      sealed: false,
      validate: () => undefined,
      apply: async (change: RecordChange, _mode, applyCtx) => {
        // The handler's own table write, then a rule on the second item.
        await db.lock(key(`written-${change.key}`), applyCtx);
        await db.put(key(`written-${change.key}`), change.order, applyCtx);
        if (change.key === 'q') {
          throw new RecordRuleError('A rule refuses q', 'TEST_RULE');
        }
      }
    };
    const registry = new RecordRegistry();
    registry.register(handler);
    const indexer = new RecordIndexer({
      registry,
      heads: db,
      keyring: new SenderKeyring([])
    });
    const change = (rkey: string): RecordChange => ({
      owner: OWNER,
      family: 'ps',
      type: 'follow',
      key: rkey,
      body: {},
      order: order(30),
      eventId: null,
      sealedClass: null,
      writer: 'author'
    });
    const outcome = await db.executeNativeQueriesInTransaction(
      async (connection) => {
        const callerCtx: RequestContext = { connection };
        await db.lock(key('caller'), callerCtx);
        await db.put(key('caller'), order(1), callerCtx);
        return indexer.ingestImported(
          [change('p'), change('q')],
          false,
          'live',
          callerCtx
        );
      }
    );
    expect(outcome).toEqual({
      kind: 'refused',
      reason: 'rule',
      detail: 'A rule refuses q',
      code: 'TEST_RULE'
    });
    // The caller committed: its write stays, nothing of the record does.
    await db.inTransaction(ctx, async (tx) => {
      expect(await db.lock(key('caller'), tx)).toEqual(order(1));
      expect(await db.lock(key('p'), tx)).toBeNull();
      expect(await db.lock(key('written-p'), tx)).toBeNull();
      expect(await db.lock(key('q'), tx)).toBeNull();
    });
  });

  it('needs a transaction to lock a head', async () => {
    await expect(db.lock(key('a'), {})).rejects.toThrow('needs a transaction');
  });

  it('applies two submits for one key one after the other, so the older never lands last', async () => {
    const applied: number[] = [];
    let releaseNewer: () => void = () => undefined;
    const newerHolding = new Promise<void>((resolve) => {
      releaseNewer = resolve;
    });
    let newerStarted: () => void = () => undefined;
    const newerApplying = new Promise<void>((resolve) => {
      newerStarted = resolve;
    });
    const handler: RecordTypeHandler = {
      family: 'ps',
      type: 'follow',
      sealed: false,
      validate: () => undefined,
      apply: async (change: RecordChange) => {
        if (change.order.anchor === 20) {
          newerStarted();
          await newerHolding;
        }
        applied.push(change.order.anchor);
      }
    };
    const registry = new RecordRegistry();
    registry.register(handler);
    const indexer = new RecordIndexer({
      registry,
      heads: db,
      keyring: new SenderKeyring([])
    });
    const newer = indexer.ingest(followRecord('x', order(20)), 'live', ctx);
    await newerApplying;
    // The older submit starts while the newer one holds the head's lock.
    const older = indexer.ingest(followRecord('x', order(10)), 'live', ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(applied).toEqual([]);
    releaseNewer();
    expect(await newer).toMatchObject({ kind: 'applied', changes: 1 });
    expect(await older).toMatchObject({
      kind: 'applied',
      changes: 0,
      stale: 1
    });
    expect(applied).toEqual([20]);
    await db.inTransaction(ctx, async (tx) => {
      expect(await db.lock(key('x'), tx)).toEqual(order(20));
    });
  });

  it('serializes two submits that reach an existing head together, without a deadlock', async () => {
    await db.inTransaction(ctx, async (tx) => {
      await db.lock(key('y'), tx);
      await db.put(key('y'), order(5), tx);
    });
    const executor = executorMeetingAtHeadInsert();
    const meeting = new SignedRecordHeadsDb(() => executor);
    const registry = new RecordRegistry();
    const applied: number[] = [];
    registry.register({
      family: 'ps',
      type: 'follow',
      sealed: false,
      validate: () => undefined,
      apply: async (change: RecordChange) => {
        applied.push(change.order.anchor);
      }
    });
    const indexer = new RecordIndexer({
      registry,
      heads: meeting,
      keyring: new SenderKeyring([])
    });
    const outcomes = await Promise.allSettled([
      indexer.ingest(
        followRecord('y', order(30, `0x${'b'.repeat(64)}`)),
        'live',
        ctx
      ),
      indexer.ingest(
        followRecord('y', order(40, `0x${'c'.repeat(64)}`)),
        'live',
        ctx
      )
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled'
    ]);
    // Whichever ran first, the newer order is the head and was applied.
    expect(applied).toContain(40);
    await db.inTransaction(ctx, async (tx) => {
      expect(await db.lock(key('y'), tx)).toEqual(
        order(40, `0x${'c'.repeat(64)}`)
      );
    });
  });
});
