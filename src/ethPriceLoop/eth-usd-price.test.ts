jest.mock('@/logging', () => ({
  Logger: {
    get: () => ({ info: mockLogInfo, warn: jest.fn(), error: mockLogError })
  }
}));
const mockLogError = jest.fn();
const mockLogInfo = jest.fn();
import { EthPriceRepairError } from './eth-price-failure';
jest.mock('./eth-price-unavailable', () => ({
  getUnavailablePrices: jest.fn(),
  deferMissingPrices: jest.fn()
}));
jest.mock('./eth-price-batch-size', () => ({
  getHistoryChunkMs: jest.fn(),
  growHistoryChunk: jest.fn(),
  shrinkHistoryChunk: jest.fn()
}));
import {
  getHistoryChunkMs,
  growHistoryChunk,
  shrinkHistoryChunk
} from './eth-price-batch-size';
import { SqlExecutionBudgetExceededError } from '@/db/sql-execution-budget';
import {
  getUnavailablePrices,
  deferMissingPrices
} from './eth-price-unavailable';
jest.mock('./coinbase', () => ({
  ...jest.requireActual('./coinbase'),
  fetchLivePrice: jest.fn(),
  fetchHistoricPrices: jest.fn()
}));
jest.mock('./eth-price-recovery.db', () => ({
  GAP_PAGE_SIZE: 8,
  ethPriceRecoveryDb: {
    findGaps: jest.fn(),
    repair: jest.fn(),
    saveLive: jest.fn()
  }
}));
jest.mock('./eth-price-reset', () => ({
  getPriceReset: jest.fn(),
  savePriceReset: jest.fn()
}));
import { syncEthUsdPrice } from './eth_usd_price';
import {
  fetchHistoricPrices,
  fetchLivePrice,
  PRICE_INTERVAL_MS,
  HISTORY_CHUNK_MS
} from './coinbase';
import { ethPriceRecoveryDb as db } from './eth-price-recovery.db';
import { getPriceReset, savePriceReset } from './eth-price-reset';
const now = Date.UTC(2026, 8, 28, 12, 2);
const closed = Date.UTC(2026, 8, 28, 12);
const live = { timestamp_ms: now, date: new Date(now), usd_price: 2600 };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getHistoryChunkMs).mockResolvedValue(HISTORY_CHUNK_MS);
  jest.mocked(shrinkHistoryChunk).mockResolvedValue(undefined);
  jest.mocked(growHistoryChunk).mockImplementation(async (size) => size);
  jest.mocked(getUnavailablePrices).mockResolvedValue([]);
  jest.mocked(deferMissingPrices).mockResolvedValue(undefined);
  jest.spyOn(Date, 'now').mockReturnValue(now);
  jest.mocked(db.findGaps).mockResolvedValue([]);
  jest.mocked(db.repair).mockResolvedValue(undefined);
  jest.mocked(db.saveLive).mockResolvedValue(undefined);
  jest.mocked(getPriceReset).mockResolvedValue(null);
  jest.mocked(savePriceReset).mockResolvedValue(undefined);
  jest.mocked(fetchLivePrice).mockResolvedValue(live);
  jest.mocked(fetchHistoricPrices).mockImplementation(async (first, last) =>
    Array.from({ length: (last - first) / PRICE_INTERVAL_MS + 1 }, (_, i) => {
      const timestamp_ms = first + i * PRICE_INTERVAL_MS;
      return { ...live, timestamp_ms, date: new Date(timestamp_ms) };
    })
  );
});
afterEach(() => jest.restoreAllMocks());
it('only collects live when coverage is healthy', async () => {
  await syncEthUsdPrice(false);
  expect(fetchHistoricPrices).not.toHaveBeenCalled();
  expect(db.repair).not.toHaveBeenCalled();
  expect(db.saveLive).toHaveBeenCalledWith(live);
});
it('drains a gap with small DB batches from one provider page after saving live', async () => {
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 4 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(fetchHistoricPrices).mockResolvedValue(
    [1, 2, 3].map((i) => ({
      ...live,
      timestamp_ms: closed - i * PRICE_INTERVAL_MS
    }))
  );
  await syncEthUsdPrice(false);
  expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
  expect(db.repair).toHaveBeenCalledTimes(3);
  expect(db.repair).toHaveBeenNthCalledWith(
    1,
    [expect.objectContaining({ timestamp_ms: closed - PRICE_INTERVAL_MS })],
    false,
    now
  );
  expect(db.repair).toHaveBeenNthCalledWith(
    3,
    [expect.objectContaining({ timestamp_ms: closed - 3 * PRICE_INTERVAL_MS })],
    false,
    now
  );
  expect(jest.mocked(db.saveLive).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(db.findGaps).mock.invocationCallOrder[0]
  );
});
it('repairs an interior hole even after newer live samples exist', async () => {
  const end = closed - 3600_000;
  jest.mocked(db.findGaps).mockResolvedValue([{ start: end - 900_000, end }]);
  await syncEthUsdPrice(false);
  expect(fetchHistoricPrices).toHaveBeenCalledWith(
    end - 600_000,
    end - PRICE_INTERVAL_MS
  );
});
it('still saves live and reports failure if history is unavailable', async () => {
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([{ start: now - 3600_000, end: now }]);
  jest.mocked(fetchHistoricPrices).mockRejectedValue(new Error('429'));
  await expect(syncEthUsdPrice(false)).rejects.toThrow('incomplete work');
  expect(db.saveLive).toHaveBeenCalledWith(live);
});
it('does not advance a reset checkpoint on failed database correction', async () => {
  jest
    .mocked(getPriceReset)
    .mockResolvedValue({ next: closed - 600_000, end: closed, latched: true });
  jest.mocked(db.repair).mockRejectedValue(new Error('rollback'));
  await expect(syncEthUsdPrice(true)).rejects.toThrow();
  expect(savePriceReset).not.toHaveBeenCalled();
  expect(shrinkHistoryChunk).toHaveBeenCalledWith(
    expect.any(Error),
    closed - 600_000,
    closed
  );
  expect(db.saveLive).toHaveBeenCalledWith(live);
});

it('uses small database batches for gaps and checkpoints each reset batch', async () => {
  jest.mocked(getHistoryChunkMs).mockResolvedValue(2 * PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 3 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(getPriceReset).mockResolvedValue({
    next: closed - 3 * PRICE_INTERVAL_MS,
    end: closed,
    latched: true
  });
  const checkpoints: number[] = [];
  jest.mocked(savePriceReset).mockImplementation(async (state) => {
    checkpoints.push(state.next);
  });
  await syncEthUsdPrice(true);
  expect(fetchHistoricPrices).toHaveBeenCalledTimes(2);
  expect(fetchHistoricPrices).toHaveBeenNthCalledWith(
    1,
    closed - 2 * PRICE_INTERVAL_MS,
    closed - PRICE_INTERVAL_MS
  );
  expect(fetchHistoricPrices).toHaveBeenNthCalledWith(
    2,
    closed - 3 * PRICE_INTERVAL_MS,
    closed
  );
  expect(checkpoints).toEqual([
    closed - PRICE_INTERVAL_MS,
    closed + PRICE_INTERVAL_MS
  ]);
  expect(db.repair).toHaveBeenCalledTimes(3);
});

it('retains completed reset progress when a later small batch times out', async () => {
  jest.mocked(getHistoryChunkMs).mockResolvedValue(2 * PRICE_INTERVAL_MS);
  const state = {
    next: closed - 3 * PRICE_INTERVAL_MS,
    end: closed,
    latched: true
  };
  jest.mocked(getPriceReset).mockResolvedValue(state);
  const error = new SqlExecutionBudgetExceededError(
    'SQL_BUDGET_EXCEEDED',
    'WORK',
    'NOT_SENT'
  );
  jest
    .mocked(db.repair)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(error);
  await expect(syncEthUsdPrice(true)).rejects.toThrow('incomplete work');
  expect(savePriceReset).toHaveBeenCalledTimes(1);
  expect(state.next).toBe(closed - PRICE_INTERVAL_MS);
  expect(shrinkHistoryChunk).toHaveBeenCalledWith(
    error,
    closed - PRICE_INTERVAL_MS,
    closed
  );
  expect(deferMissingPrices).toHaveBeenCalledTimes(1);
  expect(db.saveLive).toHaveBeenCalledWith(live);
});

it('learns a smaller gap repair after timeout without marking it unavailable', async () => {
  const error = new SqlExecutionBudgetExceededError(
    'SQL_BUDGET_EXCEEDED',
    'WORK',
    'NOT_SENT'
  );
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([{ start: closed - HISTORY_CHUNK_MS, end: closed }]);
  jest.mocked(db.repair).mockRejectedValue(error);
  await expect(syncEthUsdPrice(false)).rejects.toThrow('incomplete work');
  expect(shrinkHistoryChunk).toHaveBeenCalledWith(
    error,
    closed - HISTORY_CHUNK_MS + PRICE_INTERVAL_MS,
    closed - PRICE_INTERVAL_MS
  );
  expect(deferMissingPrices).not.toHaveBeenCalled();
  expect(db.repair).toHaveBeenCalledTimes(1);
  expect(db.saveLive).toHaveBeenCalledWith(live);
});

it('stops other gaps and reset after a timed-out repair', async () => {
  const olderEnd = closed - 2 * HISTORY_CHUNK_MS;
  jest.mocked(db.findGaps).mockResolvedValue([
    { start: closed - HISTORY_CHUNK_MS, end: closed },
    { start: olderEnd - HISTORY_CHUNK_MS, end: olderEnd }
  ]);
  const error = new SqlExecutionBudgetExceededError(
    'SQL_BUDGET_EXCEEDED',
    'WORK',
    'NOT_SENT'
  );
  jest
    .mocked(db.repair)
    .mockRejectedValueOnce(
      new EthPriceRepairError('update-transactions', error)
    )
    .mockResolvedValue(undefined);
  jest.mocked(shrinkHistoryChunk).mockResolvedValue(2 * PRICE_INTERVAL_MS);
  await expect(syncEthUsdPrice(false)).rejects.toThrow('incomplete work');
  expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
  expect(db.repair).toHaveBeenCalledTimes(1);
  expect(getPriceReset).not.toHaveBeenCalled();
  expect(shrinkHistoryChunk).toHaveBeenCalledWith(
    error,
    closed - HISTORY_CHUNK_MS + PRICE_INTERVAL_MS,
    closed - PRICE_INTERVAL_MS
  );
  expect(mockLogError).toHaveBeenCalledTimes(1);
  expect(mockLogError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      liveSaved: true,
      historyStopped: true,
      failures: [
        expect.objectContaining({
          stage: 'update-transactions',
          code: 'SQL_BUDGET_EXCEEDED'
        })
      ]
    }),
    expect.any(Error)
  );
  expect(db.saveLive).toHaveBeenCalledWith(live);
});
it('resumes reset even after reset flag is cleared and checkpoints after commit', async () => {
  jest
    .mocked(getPriceReset)
    .mockResolvedValue({ next: closed - 600_000, end: closed, latched: false });
  await syncEthUsdPrice(false);
  expect(db.repair).toHaveBeenCalledWith(expect.any(Array), true, now);
  expect(savePriceReset).toHaveBeenCalledWith({
    next: closed + PRICE_INTERVAL_MS,
    end: closed,
    latched: false
  });
});
it('continues reset beyond eight small batches in one invocation', async () => {
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest.mocked(getPriceReset).mockResolvedValue({
    next: closed - 11 * PRICE_INTERVAL_MS,
    end: closed,
    latched: true
  });
  await syncEthUsdPrice(true);
  expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
  expect(db.repair).toHaveBeenCalledTimes(12);
  expect(savePriceReset).toHaveBeenCalledTimes(12);
});
it('surfaces a failed live fetch while still allowing historical repair', async () => {
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([{ start: now - 3600_000, end: now }]);
  jest.mocked(fetchLivePrice).mockRejectedValue(new Error('timeout'));
  await expect(syncEthUsdPrice(false)).rejects.toThrow();
  expect(db.repair).toHaveBeenCalled();
  expect(db.saveLive).not.toHaveBeenCalled();
});

it('continues independent holes after one provider range fails', async () => {
  jest.mocked(db.findGaps).mockResolvedValue([
    { start: closed - 900_000, end: closed },
    { start: closed - 1800_000, end: closed - 1200_000 }
  ]);
  jest
    .mocked(fetchHistoricPrices)
    .mockRejectedValueOnce(new Error('missing candle'));
  await expect(syncEthUsdPrice(false)).rejects.toThrow();
  expect(fetchHistoricPrices).toHaveBeenCalledTimes(2);
  expect(db.repair).toHaveBeenCalledTimes(1);
  expect(db.saveLive).toHaveBeenCalledWith(live);
});

it('passes retry exclusions to gap discovery and continues a partial reset', async () => {
  const range = {
    first: closed - 900_000,
    last: closed - 600_000,
    retryAt: now + 3600_000
  };
  jest.mocked(getUnavailablePrices).mockResolvedValue([range]);
  jest
    .mocked(getPriceReset)
    .mockResolvedValue({ next: closed - 300_000, end: closed, latched: true });
  const candle = { ...live, timestamp_ms: closed };
  jest.mocked(fetchHistoricPrices).mockResolvedValue([candle]);
  await syncEthUsdPrice(true);
  expect(db.findGaps).toHaveBeenCalledWith(now, [range], now);
  expect(deferMissingPrices).toHaveBeenCalledWith(
    [candle],
    closed - 300_000,
    closed,
    now
  );
  expect(savePriceReset).toHaveBeenCalledWith({
    next: closed + 300_000,
    end: closed,
    latched: true
  });
});
it('advances a reset scan past empty history while leaving missing prices for retry', async () => {
  jest
    .mocked(getPriceReset)
    .mockResolvedValue({ next: closed, end: closed, latched: true });
  jest.mocked(fetchHistoricPrices).mockResolvedValue([]);
  await syncEthUsdPrice(true);
  expect(deferMissingPrices).toHaveBeenCalledWith([], closed, closed, now);
  expect(savePriceReset).toHaveBeenCalledWith({
    next: closed + 300_000,
    end: closed,
    latched: true
  });
  expect(db.saveLive).toHaveBeenCalledWith(live);
});

it.each(['ER_LOCK_WAIT_TIMEOUT', 'ER_LOCK_DEADLOCK', 'ECONNRESET'])(
  'stops historical work after database failure %s without cooling down the gap',
  async (code) => {
    jest.mocked(db.findGaps).mockResolvedValue([
      { start: closed - 900_000, end: closed },
      { start: closed - 1800_000, end: closed - 1200_000 }
    ]);
    jest
      .mocked(db.repair)
      .mockRejectedValue(
        Object.assign(new Error('database failure'), { code })
      );
    await expect(syncEthUsdPrice(true)).rejects.toThrow('incomplete work');
    expect(db.repair).toHaveBeenCalledTimes(1);
    expect(getPriceReset).not.toHaveBeenCalled();
    expect(deferMissingPrices).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledTimes(1);
  }
);

it('does not add historical load after a live database failure', async () => {
  jest
    .mocked(db.saveLive)
    .mockRejectedValue(
      Object.assign(new Error('locked'), { code: 'ER_LOCK_WAIT_TIMEOUT' })
    );
  await expect(syncEthUsdPrice(true)).rejects.toThrow('incomplete work');
  expect(db.findGaps).not.toHaveBeenCalled();
  expect(getPriceReset).not.toHaveBeenCalled();
  expect(mockLogError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ liveSaved: false, historyStopped: true }),
    expect.any(Error)
  );
});

it('logs one summary for multiple provider failures without database or HTTP payloads', async () => {
  jest.mocked(db.findGaps).mockResolvedValue([
    { start: closed - 900_000, end: closed },
    { start: closed - 1800_000, end: closed - 1200_000 }
  ]);
  jest.mocked(fetchHistoricPrices).mockRejectedValue(
    Object.assign(new Error('private payload'), {
      code: 'ECONNABORTED',
      sql: 'private SQL'
    })
  );
  await expect(syncEthUsdPrice(false)).rejects.toThrow('incomplete work');
  expect(mockLogError).toHaveBeenCalledTimes(1);
  expect(mockLogError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ errorCount: 2, liveSaved: true }),
    expect.any(Error)
  );
  expect(JSON.stringify(mockLogError.mock.calls)).not.toContain('private');
});

it('stops reset when gap discovery fails', async () => {
  jest.mocked(db.findGaps).mockRejectedValue(new Error('database unavailable'));
  await expect(syncEthUsdPrice(true)).rejects.toThrow('incomplete work');
  expect(getPriceReset).not.toHaveBeenCalled();
  expect(db.saveLive).toHaveBeenCalledWith(live);
});

it('logs and throws the same aggregate Error for handler-level deduplication', async () => {
  jest.mocked(fetchLivePrice).mockRejectedValue(new Error('unavailable'));
  let thrown: unknown;
  try {
    await syncEthUsdPrice(false);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(mockLogError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ errorCount: 1 }),
    thrown
  );
});

it.each(['provider', 'checkpoint'] as const)(
  'fails visibly and stops sequential reset work after a %s failure',
  async (stage) => {
    const first = closed - 2 * PRICE_INTERVAL_MS;
    jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
    jest
      .mocked(getPriceReset)
      .mockResolvedValue({ next: first, end: closed, latched: true });
    if (stage === 'provider') {
      jest
        .mocked(fetchHistoricPrices)
        .mockRejectedValue(new Error('provider failure'));
    } else {
      jest
        .mocked(savePriceReset)
        .mockRejectedValue(new Error('checkpoint failure'));
    }
    await expect(syncEthUsdPrice(true)).rejects.toThrow('incomplete work');
    expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
    expect(db.repair).toHaveBeenCalledTimes(stage === 'provider' ? 0 : 1);
    expect(savePriceReset).toHaveBeenCalledTimes(stage === 'provider' ? 0 : 1);
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        liveSaved: true,
        failures: [
          expect.objectContaining({
            operation: `reset-${stage}`,
            first,
            last: stage === 'provider' ? closed : first
          })
        ]
      }),
      expect.any(Error)
    );
  }
);

it.each([0, 1, PRICE_INTERVAL_MS - 1])(
  'selects a missing close with a one-candle limit and endpoint offset %i',
  async (offset) => {
    jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
    const end = closed - 3600_000 + offset;
    const expected = closed - 3600_000 - (offset === 0 ? PRICE_INTERVAL_MS : 0);
    jest
      .mocked(db.findGaps)
      .mockResolvedValue([{ start: end - 1200_000, end }]);
    jest
      .mocked(fetchHistoricPrices)
      .mockResolvedValue([
        { ...live, timestamp_ms: expected, date: new Date(expected) }
      ]);
    await syncEthUsdPrice(false);
    expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
    expect(fetchHistoricPrices).toHaveBeenCalledWith(
      (Math.floor((end - 1200_000) / PRICE_INTERVAL_MS) + 1) *
        PRICE_INTERVAL_MS,
      expected
    );
    expect(db.repair).toHaveBeenNthCalledWith(
      1,
      [expect.objectContaining({ timestamp_ms: expected })],
      false,
      now
    );
    expect(mockLogInfo).toHaveBeenCalledWith(
      `[ETH PRICE GAP REPAIR] [PROCESSED CANDLES 1] [FROM ${expected}] [THROUGH ${expected}]`
    );
  }
);

it('reports zero processed candles for empty history without claiming inserts', async () => {
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([{ start: closed - 900_000, end: closed }]);
  jest.mocked(fetchHistoricPrices).mockResolvedValue([]);
  await syncEthUsdPrice(false);
  expect(mockLogInfo).toHaveBeenCalledWith(
    `[ETH PRICE GAP REPAIR] [PROCESSED CANDLES 0] [FROM ${closed - 600_000}] [THROUGH ${closed - 300_000}]`
  );
  expect(deferMissingPrices).toHaveBeenCalledWith(
    [],
    closed - 600_000,
    closed - 300_000,
    now
  );
});

it('stops between batches before the Lambda reserve and leaves unprocessed candles for rediscovery', async () => {
  let remaining = 121_000;
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 4 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(db.repair).mockImplementation(async () => {
    remaining = 119_000;
  });
  await syncEthUsdPrice(false, () => remaining);
  expect(db.repair).toHaveBeenCalledTimes(1);
  expect(deferMissingPrices).toHaveBeenCalledTimes(1);
  expect(getPriceReset).not.toHaveBeenCalled();
  expect(mockLogInfo).toHaveBeenCalledWith(
    '[ETH PRICE RECOVERY SUMMARY]',
    expect.objectContaining({
      deadlineReached: true,
      coverageScanComplete: false,
      attemptedChunks: 1
    })
  );
});

it('refreshes live prices between batches after five minutes and keeps recovering', async () => {
  let time = now;
  jest.spyOn(Date, 'now').mockImplementation(() => time);
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 4 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(db.repair).mockImplementation(async () => {
    time += 160_000;
  });
  await syncEthUsdPrice(false, () => 900_000 - (time - now));
  expect(db.repair).toHaveBeenCalledTimes(3);
  expect(db.saveLive).toHaveBeenCalledTimes(2);
  expect(jest.mocked(db.saveLive).mock.invocationCallOrder[1]).toBeGreaterThan(
    jest.mocked(db.repair).mock.invocationCallOrder[1]
  );
  expect(jest.mocked(db.saveLive).mock.invocationCallOrder[1]).toBeLessThan(
    jest.mocked(db.repair).mock.invocationCallOrder[2]
  );
});

it('stops recovery if an inter-batch live save fails', async () => {
  let time = now;
  jest.spyOn(Date, 'now').mockImplementation(() => time);
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 4 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(db.repair).mockImplementation(async () => {
    time += PRICE_INTERVAL_MS;
  });
  jest
    .mocked(db.saveLive)
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('locked'));
  await expect(syncEthUsdPrice(false)).rejects.toThrow('incomplete work');
  expect(db.repair).toHaveBeenCalledTimes(1);
});

it('paginates past eight gaps instead of ending the invocation', async () => {
  const gaps = Array.from({ length: 8 }, (_, i) => ({
    start: closed - (i * 3 + 2) * PRICE_INTERVAL_MS,
    end: closed - i * 3 * PRICE_INTERVAL_MS
  }));
  const older = {
    start: closed - 30 * PRICE_INTERVAL_MS,
    end: closed - 28 * PRICE_INTERVAL_MS
  };
  jest
    .mocked(db.findGaps)
    .mockResolvedValueOnce(gaps)
    .mockResolvedValueOnce([older]);
  await syncEthUsdPrice(false);
  expect(db.findGaps).toHaveBeenNthCalledWith(2, now, [], gaps[7].start);
  expect(fetchHistoricPrices).toHaveBeenCalledTimes(9);
});

it('grows the DB batch size after three fast full commits without refetching the page', async () => {
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest.mocked(growHistoryChunk).mockResolvedValue(2 * PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 6 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(fetchHistoricPrices).mockResolvedValue(
    [1, 2, 3, 4, 5].map((i) => ({
      ...live,
      timestamp_ms: closed - i * PRICE_INTERVAL_MS
    }))
  );
  await syncEthUsdPrice(false);
  expect(growHistoryChunk).toHaveBeenCalledWith(PRICE_INTERVAL_MS);
  expect(db.repair).toHaveBeenCalledTimes(4);
  expect(jest.mocked(db.repair).mock.calls[3][0]).toHaveLength(2);
  expect(fetchHistoricPrices).toHaveBeenCalledTimes(1);
});

it('rechecks the deadline after a slow inter-batch live refresh before starting another repair', async () => {
  let time = now;
  let remaining = 900_000;
  jest.spyOn(Date, 'now').mockImplementation(() => time);
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 4 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(db.repair).mockImplementation(async () => {
    time += PRICE_INTERVAL_MS;
    remaining = 121_000;
  });
  jest
    .mocked(fetchLivePrice)
    .mockResolvedValueOnce(live)
    .mockImplementationOnce(async () => {
      remaining = 119_000;
      return { ...live, timestamp_ms: time, date: new Date(time) };
    });
  await syncEthUsdPrice(false, () => remaining);
  expect(db.saveLive).toHaveBeenCalledTimes(2);
  expect(db.repair).toHaveBeenCalledTimes(1);
  expect(deferMissingPrices).toHaveBeenCalledTimes(1);
  expect(mockLogInfo).toHaveBeenCalledWith(
    '[ETH PRICE RECOVERY SUMMARY]',
    expect.objectContaining({
      stopReason: 'time-budget',
      deadlineReached: true,
      attemptedChunks: 1
    })
  );
});

it('finishes historical batches but reports a failed inter-batch live provider request', async () => {
  let time = now;
  jest.spyOn(Date, 'now').mockImplementation(() => time);
  jest.mocked(getHistoryChunkMs).mockResolvedValue(PRICE_INTERVAL_MS);
  jest
    .mocked(db.findGaps)
    .mockResolvedValue([
      { start: closed - 4 * PRICE_INTERVAL_MS, end: closed }
    ]);
  jest.mocked(db.repair).mockImplementationOnce(async () => {
    time += PRICE_INTERVAL_MS;
  });
  jest
    .mocked(fetchLivePrice)
    .mockResolvedValueOnce(live)
    .mockRejectedValueOnce(new Error('ticker unavailable'));
  await expect(syncEthUsdPrice(false)).rejects.toThrow('incomplete work');
  expect(db.repair).toHaveBeenCalledTimes(3);
  expect(fetchLivePrice).toHaveBeenCalledTimes(2);
  expect(mockLogError).toHaveBeenCalledTimes(1);
  expect(mockLogError).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      stopReason: 'failure',
      liveSaved: true,
      historyStopped: false,
      committedBatches: 3,
      coverageScanComplete: true,
      errorCount: 1,
      failures: [expect.objectContaining({ operation: 'live-provider' })]
    }),
    expect.any(Error)
  );
});
