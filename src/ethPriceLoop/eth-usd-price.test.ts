import type { AxiosError } from 'axios';

const mockGet = jest.fn();
const mockCreate = jest.fn(() => ({ get: mockGet }));
const mockIsAxiosError = jest.fn(
  (error: unknown) => !!(error as { isAxiosError?: boolean })?.isAxiosError
);

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: mockCreate,
    isAxiosError: mockIsAxiosError
  }
}));

const mockExponentialDelay = jest.fn(() => 1234);
const mockIsNetworkError = jest.fn(() => false);
const mockIsRetryableError = jest.fn(() => false);
const mockAxiosRetry = jest.fn();

jest.mock('axios-retry', () => ({
  __esModule: true,
  default: Object.assign(mockAxiosRetry, {
    exponentialDelay: mockExponentialDelay,
    isNetworkError: mockIsNetworkError,
    isRetryableError: mockIsRetryableError
  })
}));

jest.mock('./db.eth_price', () => ({
  getEthPriceCount: jest.fn(),
  persistEthPrices: jest.fn()
}));

const mockInfo = jest.fn();
const mockWarn = jest.fn();

jest.mock('../logging', () => ({
  Logger: {
    get: jest.fn(() => ({
      info: mockInfo,
      warn: mockWarn
    }))
  }
}));

import { getEthPriceCount, persistEthPrices } from './db.eth_price';
import { syncEthUsdPrice } from './eth_usd_price';

const MOBULA_CURRENT_URL =
  'https://api.mobula.io/api/1/market/data?asset=Ethereum';

type RetryConfig = {
  retries: number;
  retryDelay: (retryCount: number, error: AxiosError) => number;
  retryCondition: (error: AxiosError) => boolean;
  shouldResetTimeout: boolean;
};

function getRetryConfig(): RetryConfig {
  return mockAxiosRetry.mock.calls[0][1] as RetryConfig;
}

function buildAxiosError(
  status: number,
  headers: Record<string, unknown> = {}
): AxiosError {
  return {
    isAxiosError: true,
    response: {
      status,
      headers
    }
  } as AxiosError;
}

describe('syncEthUsdPrice', () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockIsAxiosError.mockClear();
    mockExponentialDelay.mockClear();
    mockIsNetworkError.mockReturnValue(false);
    mockIsRetryableError.mockReturnValue(false);
    mockInfo.mockClear();
    mockWarn.mockClear();
    (getEthPriceCount as jest.Mock).mockReset();
    (persistEthPrices as jest.Mock).mockReset();
    process.env.MOBULA_API_KEY = 'mobula-key';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.MOBULA_API_KEY;
  });

  it('persists the latest Mobula ETH price', async () => {
    const nowMs = 1710000000000;
    jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    (getEthPriceCount as jest.Mock).mockResolvedValue(1);
    mockGet.mockResolvedValue({
      data: {
        data: {
          price: 3133.12
        }
      }
    });

    await syncEthUsdPrice(false);

    expect(mockGet).toHaveBeenCalledWith(MOBULA_CURRENT_URL, {
      headers: {
        Authorization: 'Bearer mobula-key'
      }
    });
    expect(persistEthPrices).toHaveBeenCalledWith([
      {
        timestamp_ms: nowMs,
        date: new Date(nowMs),
        usd_price: 3133.12
      }
    ]);
  });

  it('omits authorization when Mobula API key is absent', async () => {
    delete process.env.MOBULA_API_KEY;
    (getEthPriceCount as jest.Mock).mockResolvedValue(1);
    mockGet.mockResolvedValue({
      data: {
        data: {
          price: 3133.12
        }
      }
    });

    await syncEthUsdPrice(false);

    expect(mockGet).toHaveBeenCalledWith(MOBULA_CURRENT_URL, {
      headers: undefined
    });
  });

  it('skips the latest sample when Mobula remains rate limited', async () => {
    (getEthPriceCount as jest.Mock).mockResolvedValue(1);
    mockGet.mockRejectedValue(buildAxiosError(429, { 'retry-after': '120' }));

    await expect(syncEthUsdPrice(false)).resolves.toBeUndefined();

    expect(persistEthPrices).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      '[CURRENT DATA SKIPPED] : [MOBULA HTTP 429] [RETRY_AFTER_MS 120000]'
    );
  });

  it('skips the historic reset sample when Mobula remains rate limited', async () => {
    (getEthPriceCount as jest.Mock).mockResolvedValue(0);
    mockGet.mockRejectedValue(buildAxiosError(429));

    await expect(syncEthUsdPrice(false)).resolves.toBeUndefined();

    expect(persistEthPrices).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      '[HISTORIC DATA SKIPPED] : [MOBULA HTTP 429] [RETRY_AFTER_MS -1]'
    );
  });

  it('rethrows non-rate-limit Mobula failures', async () => {
    const error = buildAxiosError(500);
    (getEthPriceCount as jest.Mock).mockResolvedValue(1);
    mockGet.mockRejectedValue(error);

    await expect(syncEthUsdPrice(false)).rejects.toBe(error);
  });

  it('configures bounded retries for transient Mobula responses', () => {
    const retryConfig = getRetryConfig();

    expect(retryConfig.retries).toBe(3);
    expect(retryConfig.shouldResetTimeout).toBe(true);
    expect(retryConfig.retryCondition(buildAxiosError(500))).toBe(true);
    expect(retryConfig.retryCondition(buildAxiosError(429))).toBe(true);
    expect(
      retryConfig.retryCondition(buildAxiosError(429, { 'retry-after': '31' }))
    ).toBe(false);
    expect(
      retryConfig.retryDelay(1, buildAxiosError(429, { 'retry-after': '5' }))
    ).toBe(5000);
    expect(retryConfig.retryDelay(1, buildAxiosError(503))).toBe(1234);
    expect(mockExponentialDelay).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        response: expect.objectContaining({ status: 503 })
      })
    );
  });
});
