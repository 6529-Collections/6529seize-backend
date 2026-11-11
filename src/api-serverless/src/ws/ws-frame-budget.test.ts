import fc from 'fast-check';
import { RedisUnavailableError } from '@/redis';
import {
  InMemoryTokenBuckets,
  WS_FRAME_BUDGET_DEFAULT,
  WS_TYPING_FRAME_BUDGET_DEFAULT,
  WsFrameBudget,
  wsFrameBudgetLimits
} from './ws-frame-budget';
import { WsMessageType } from './ws-message';

describe('wsFrameBudgetLimits', () => {
  it('defaults to 30 frames burst at 5/s and 5 typing frames burst at 0.5/s', () => {
    expect(wsFrameBudgetLimits({})).toEqual({
      frames: { burst: 30, perSecond: 5 },
      typing: { burst: 5, perSecond: 0.5 }
    });
  });

  it('reads positive numbers and ignores anything else', () => {
    expect(
      wsFrameBudgetLimits({
        WS_FRAME_BUDGET_BURST: '60',
        WS_FRAME_BUDGET_PER_SECOND: '10',
        WS_TYPING_FRAME_BUDGET_BURST: '0',
        WS_TYPING_FRAME_BUDGET_PER_SECOND: 'fast'
      })
    ).toEqual({
      frames: { burst: 60, perSecond: 10 },
      typing: WS_TYPING_FRAME_BUDGET_DEFAULT
    });
  });
});

describe('InMemoryTokenBuckets', () => {
  const bucket = { key: 'a', capacity: 3, refillPerSecond: 1 };

  it('admits a full burst, then one frame per refilled token', () => {
    const buckets = new InMemoryTokenBuckets();
    const admitted = [0, 0, 0, 0].map(() => buckets.take([bucket], 0));
    expect(admitted).toEqual([true, true, true, false]);
    expect(buckets.take([bucket], 999)).toBe(false);
    expect(buckets.take([bucket], 1_000)).toBe(true);
  });

  it('never refills past the capacity', () => {
    const buckets = new InMemoryTokenBuckets();
    buckets.take([bucket], 0);
    const admitted = [0, 0, 0, 0].map(() => buckets.take([bucket], 60_000));
    expect(admitted).toEqual([true, true, true, false]);
  });

  it('takes from no bucket when one of them is empty', () => {
    const buckets = new InMemoryTokenBuckets();
    const tight = { key: 'tight', capacity: 1, refillPerSecond: 0.001 };
    expect(buckets.take([bucket, tight], 0)).toBe(true);
    expect(buckets.take([bucket, tight], 0)).toBe(false);
    // The rejected frame did not spend the wide bucket's tokens.
    expect(buckets.take([bucket], 0)).toBe(true);
    expect(buckets.take([bucket], 0)).toBe(true);
    expect(buckets.take([bucket], 0)).toBe(false);
  });

  it('keeps at most its entry limit, dropping the oldest first', () => {
    const buckets = new InMemoryTokenBuckets(2);
    buckets.take([{ ...bucket, key: 'x' }], 0);
    buckets.take([{ ...bucket, key: 'y' }], 0);
    buckets.take([{ ...bucket, key: 'z' }], 0);
    expect(buckets.size).toBe(2);
  });

  it('never admits more than burst plus the refill over any period', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 2_000 }), {
          minLength: 1,
          maxLength: 200
        }),
        (gaps) => {
          const buckets = new InMemoryTokenBuckets();
          let now = 0;
          let admitted = 0;
          for (const gap of gaps) {
            now += gap;
            if (buckets.take([bucket], now)) admitted++;
          }
          expect(admitted).toBeLessThanOrEqual(
            bucket.capacity + Math.floor((now * bucket.refillPerSecond) / 1000)
          );
        }
      )
    );
  });
});

describe('WsFrameBudget', () => {
  const limits = () => ({
    frames: WS_FRAME_BUDGET_DEFAULT,
    typing: WS_TYPING_FRAME_BUDGET_DEFAULT
  });

  it('charges ordinary frames to the connection bucket only', async () => {
    const takeShared = jest.fn().mockResolvedValue(true);
    const budget = new WsFrameBudget(
      takeShared,
      undefined,
      () => 1_000,
      limits
    );

    await expect(
      budget.take('conn-1', WsMessageType.SUBSCRIBE_TO_WAVE)
    ).resolves.toBe('allowed');

    expect(takeShared).toHaveBeenCalledWith(
      [{ key: '{ws_frames:conn-1}:all', capacity: 30, refillPerSecond: 5 }],
      1_000,
      6_000
    );
  });

  it('charges typing frames to both buckets in one hash slot', async () => {
    const takeShared = jest.fn().mockResolvedValue(false);
    const budget = new WsFrameBudget(
      takeShared,
      undefined,
      () => 1_000,
      limits
    );

    await expect(
      budget.take('conn-1', WsMessageType.USER_IS_TYPING)
    ).resolves.toBe('rejected');

    expect(takeShared).toHaveBeenCalledWith(
      [
        { key: '{ws_frames:conn-1}:all', capacity: 30, refillPerSecond: 5 },
        { key: '{ws_frames:conn-1}:typing', capacity: 5, refillPerSecond: 0.5 }
      ],
      1_000,
      10_000
    );
  });

  it('falls back to the in-memory buckets while Redis is unavailable', async () => {
    const takeShared = jest
      .fn()
      .mockRejectedValue(new RedisUnavailableError('down'));
    const budget = new WsFrameBudget(
      takeShared,
      new InMemoryTokenBuckets(),
      () => 0,
      limits
    );

    const decisions = [];
    for (let i = 0; i < 6; i++) {
      decisions.push(await budget.take('conn-1', WsMessageType.USER_IS_TYPING));
    }

    expect(decisions).toEqual([
      'allowed',
      'allowed',
      'allowed',
      'allowed',
      'allowed',
      'rejected'
    ]);
  });

  it('uses the in-memory buckets when Redis is not configured', async () => {
    const budget = new WsFrameBudget(
      jest.fn().mockResolvedValue(null),
      new InMemoryTokenBuckets(),
      () => 0,
      () => ({
        frames: { burst: 1, perSecond: 1 },
        typing: WS_TYPING_FRAME_BUDGET_DEFAULT
      })
    );

    await expect(budget.take('conn-1', null)).resolves.toBe('allowed');
    await expect(budget.take('conn-1', null)).resolves.toBe('rejected');
    await expect(budget.take('conn-2', null)).resolves.toBe('allowed');
  });
});
