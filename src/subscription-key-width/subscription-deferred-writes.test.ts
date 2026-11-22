import {
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import {
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
  subscriptionKeyWidths: { narrowFor: jest.fn() }
}));

const execute = sqlExecutor.execute as jest.Mock;
const narrowFor = subscriptionKeyWidths.narrowFor as jest.Mock;
const LONG_KEY = 'k'.repeat(250);

describe('deferred subscription writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('queues each write with its reason and logs it with the alert code', async () => {
    const sink = { query: jest.fn() };
    await deferSubscriptionWrites(
      [
        {
          kind: 'SUBSCRIPTION',
          consolidationKey: LONG_KEY,
          payload: { token_id: 600 },
          narrow: [{ table: SUBSCRIPTIONS_NFTS_TABLE, width: 200 }]
        }
      ],
      sink,
      1234
    );
    expect(sink.query).toHaveBeenCalledWith(
      expect.stringContaining(
        `INSERT INTO ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}`
      ),
      [
        expect.any(String),
        'SUBSCRIPTION',
        LONG_KEY,
        250,
        '{"token_id":600}',
        `key of 250 characters; ${SUBSCRIPTIONS_NFTS_TABLE} holds 200`,
        1234
      ]
    );
    expect(errorWithCode).toHaveBeenCalledWith(
      'SUBSCRIPTION_KEY_DEFERRED',
      expect.stringContaining('[SUBSCRIPTION]')
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

  it('replays writes that fit now, waits on the rest, and keeps failures queued', async () => {
    execute.mockResolvedValueOnce([
      {
        id: 'a',
        kind: 'SUBSCRIPTION',
        consolidation_key: 'short',
        payload: '{"n":1}',
        created_at: 1
      },
      {
        id: 'b',
        kind: 'SUBSCRIPTION',
        consolidation_key: LONG_KEY,
        payload: {},
        created_at: 2
      },
      {
        id: 'c',
        kind: 'LOG',
        consolidation_key: 'short',
        payload: {},
        created_at: 3
      },
      {
        id: 'd',
        kind: 'MODE',
        consolidation_key: 'short',
        payload: {},
        created_at: 4
      },
      {
        id: 'e',
        kind: 'TOP_UP',
        consolidation_key: 'short',
        payload: {},
        created_at: 5
      }
    ]);
    narrowFor.mockImplementation(async (key: string) =>
      key === LONG_KEY ? [{ table: SUBSCRIPTIONS_NFTS_TABLE, width: 200 }] : []
    );
    const subscription = jest.fn().mockResolvedValue('DONE');
    const log = jest.fn().mockResolvedValue('SKIPPED');
    const mode = jest.fn().mockRejectedValue(new Error('boom'));
    const summary = await replayDeferredSubscriptionWrites(
      { SUBSCRIPTION: subscription, LOG: log, MODE: mode },
      { nowMs: () => 99 }
    );
    expect(summary).toEqual({ done: 1, skipped: 1, waiting: 2, failed: 1 });
    expect(subscription).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', payload: { n: 1 } })
    );
    const updates = execute.mock.calls.filter(([sql]) =>
      String(sql).includes('SET replayed_at')
    );
    expect(updates.map(([, params]) => params)).toEqual([
      { replayedAt: 99, outcome: 'DONE', id: 'a' },
      { replayedAt: 99, outcome: 'SKIPPED', id: 'c' }
    ]);
  });
});
