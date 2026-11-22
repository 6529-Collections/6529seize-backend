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
});
