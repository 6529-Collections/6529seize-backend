import { createHash } from 'node:crypto';
import {
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
  claimDeferredWrite,
  deferralMessage,
  deferralReason,
  deferSubscriptionWrites,
  executorSink,
  replayDeferredSubscriptionWrites
} from './subscription-deferred-writes';
import { subscriptionKeyWidths } from './subscription-key-width';

const errorWithCode = jest.fn();
jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      errorWithCode: (...args: unknown[]) => errorWithCode(...args)
    })
  }
}));
jest.mock('@/sql-executor', () => ({ sqlExecutor: { execute: jest.fn() } }));
jest.mock('./subscription-key-width', () => ({
  subscriptionKeyWidths: { narrowFor: jest.fn(), widthOf: jest.fn() }
}));

const execute = sqlExecutor.execute as jest.Mock;
const narrowFor = subscriptionKeyWidths.narrowFor as jest.Mock;
const widthOf = subscriptionKeyWidths.widthOf as jest.Mock;
const LONG_KEY = 'k'.repeat(250);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');

describe('deferred subscription writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    narrowFor.mockResolvedValue([]);
    delete process.env.SUBSCRIPTIONS_WIDE_IDENTITY_RESUME_ON;
  });

  it('queues each write once per dedupe key, with its reason, and logs it', async () => {
    const sink = { query: jest.fn() };
    await deferSubscriptionWrites(
      [
        {
          kind: 'FINAL_ROW',
          consolidationKey: LONG_KEY,
          dedupe: `${LONG_KEY}|c|600`,
          payload: { token_id: 600 },
          reason: {
            narrow: [{ table: SUBSCRIPTIONS_REDEEMED_TABLE, width: 200 }],
            pendingEarlier: true
          }
        }
      ],
      sink,
      1234
    );
    const [sql, values] = sink.query.mock.calls[0];
    expect(sql).toContain(`INSERT INTO ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}`);
    expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(values).toEqual([
      'FINAL_ROW',
      LONG_KEY,
      sha(LONG_KEY),
      250,
      sha(`FINAL_ROW|${LONG_KEY}|c|600`),
      '{"token_id":600}',
      `key of 250 characters; ${SUBSCRIPTIONS_REDEEMED_TABLE} holds 200, an earlier write for the key is waiting`,
      1234
    ]);
    expect(errorWithCode).toHaveBeenCalledWith(
      'SUBSCRIPTION_KEY_DEFERRED',
      expect.stringContaining('[FINAL_ROW]')
    );
  });

  it('turns positional values into named parameters for the executor', async () => {
    const connection = {} as never;
    await executorSink({ wrappedConnection: connection }).query(
      'INSERT INTO t (a, b) VALUES (?, ?)',
      [1, 'x']
    );
    expect(execute).toHaveBeenCalledWith(
      'INSERT INTO t (a, b) VALUES (:p0, :p1)',
      { p0: 1, p1: 'x' },
      { wrappedConnection: connection }
    );
  });

  it('holds a key back when it does not fit or has an earlier write waiting', async () => {
    const sink = { query: jest.fn().mockResolvedValue([]) };
    expect(await deferralReason('short', sink)).toBeNull();
    narrowFor.mockResolvedValueOnce([
      { table: SUBSCRIPTIONS_NFTS_TABLE, width: 200 }
    ]);
    expect(await deferralReason(LONG_KEY, sink)).toEqual({
      narrow: [{ table: SUBSCRIPTIONS_NFTS_TABLE, width: 200 }],
      pendingEarlier: false
    });
    sink.query.mockResolvedValueOnce([{ sequence: 3 }]);
    expect(await deferralReason('short', sink, 7)).toEqual({
      narrow: [],
      pendingEarlier: true
    });
    expect(sink.query).toHaveBeenLastCalledWith(
      expect.stringContaining('AND sequence < ?'),
      [sha('short'), 7]
    );
  });

  it('tells a person how many wallets fit and when changes resume', async () => {
    widthOf.mockImplementation(async (table: string) =>
      table === SUBSCRIPTIONS_REDEEMED_TABLE ? 567 : 666
    );
    const narrow = {
      narrow: [{ table: SUBSCRIPTIONS_REDEEMED_TABLE, width: 567 }],
      pendingEarlier: false
    };
    expect(await deferralMessage(narrow)).toBe(
      'Subscriptions for identities with more than 13 wallets resume after the identity switch.'
    );
    process.env.SUBSCRIPTIONS_WIDE_IDENTITY_RESUME_ON = '26 Nov 2026';
    expect(await deferralMessage({ narrow: [], pendingEarlier: true })).toBe(
      'Subscription changes for this identity resume on 26 Nov 2026, after its earlier updates are applied.'
    );
  });

  it('claims an entry only while it is unclaimed, under a row lock', async () => {
    const sink = { query: jest.fn() };
    sink.query.mockResolvedValueOnce([{ replayed_at: null }]);
    expect(await claimDeferredWrite(5, 'DONE', sink, 9)).toBe(true);
    expect(sink.query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(sink.query.mock.calls[1][1]).toEqual([9, 'DONE', 5]);
    sink.query.mockResolvedValueOnce([{ replayed_at: 8 }]);
    expect(await claimDeferredWrite(5, 'DONE', sink)).toBe(false);
    sink.query.mockResolvedValueOnce([]);
    expect(await claimDeferredWrite(6, 'DONE', sink)).toBe(false);
  });

  it('replays in queue order, pages through the queue, and keeps each key in order', async () => {
    const entry = (sequence: number, kind: string, key: string) => ({
      sequence,
      kind,
      consolidation_key: key,
      key_hash: sha(key),
      payload: '{}'
    });
    execute
      .mockResolvedValueOnce([
        entry(1, 'LOG', 'a'),
        entry(2, 'REDEMPTION', 'b')
      ])
      .mockResolvedValueOnce([entry(3, 'LOG', 'b'), entry(4, 'LOG', LONG_KEY)])
      .mockResolvedValueOnce([entry(5, 'LOG', 'c'), entry(6, 'LOG', 'd')])
      .mockResolvedValueOnce([]);
    narrowFor.mockImplementation(async (key: string) =>
      key === LONG_KEY ? [{ table: SUBSCRIPTIONS_NFTS_TABLE, width: 200 }] : []
    );
    const log = jest
      .fn()
      .mockResolvedValueOnce('DONE')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(null);
    const summary = await replayDeferredSubscriptionWrites(
      { LOG: log },
      { pageSize: 2 }
    );
    // a done; b waits (its first entry is a redemption, replayed elsewhere)
    // and so does its later log; the long key waits; c fails; d was claimed
    // by another run.
    expect(summary).toEqual({ done: 1, skipped: 0, waiting: 3, failed: 1 });
    expect(log.mock.calls.map(([w]) => w.sequence)).toEqual([1, 5, 6]);
    expect(execute.mock.calls.map(([, params]) => params.after)).toEqual([
      0, 2, 4, 6
    ]);
  });
});
