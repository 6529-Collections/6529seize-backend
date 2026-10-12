import { initRedis } from '@/redis';
import { RateLimitingService } from './rate-limiting.service';
import { RateLimitConfig } from './rate-limiting.utils';

const mockExec = jest.fn();
const mockMulti = jest.fn(() => ({
  zAdd: jest.fn(),
  zRemRangeByScore: jest.fn(),
  zCard: jest.fn(),
  expire: jest.fn(),
  exec: mockExec
}));
const mockClient = {
  isReady: true,
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  multi: mockMulti
};

jest.mock('redis', () => ({
  createClient: jest.fn(() => mockClient)
}));

const COMMAND_TIMEOUT_MS = 40;
const config: RateLimitConfig = {
  burst: 30,
  sustainedRps: 10,
  sustainedWindowSeconds: 60
};

describe('rate limiting with fail-fast Redis', () => {
  const originalEnv = { ...process.env };
  const service = new RateLimitingService();

  beforeAll(async () => {
    process.env.FORCE_AVOID_REDIS = 'false';
    process.env.REDIS_URL = 'localhost';
    process.env.REDIS_PORT = '6379';
    await initRedis({
      failFast: {
        commandTimeoutMs: COMMAND_TIMEOUT_MS,
        connectTimeoutMs: 1_000,
        initialConnectTimeoutMs: 1_000,
        maxReconnectDelayMs: 1_000
      }
    });
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  beforeEach(() => {
    mockClient.isReady = true;
    mockExec.mockReset();
    mockMulti.mockClear();
  });

  it('enforces limits from the Redis count while Redis answers', async () => {
    mockExec.mockResolvedValue([1, 0, 31, 1]);

    const result = await service.checkRateLimit('ip:1.2.3.4', config);

    expect(result.allowed).toBe(false);
  });

  it('fails open within the command budget when the pipeline hangs', async () => {
    mockExec.mockImplementation(() => new Promise(() => undefined));

    const startedAt = Date.now();
    const result = await service.checkRateLimit('ip:1.2.3.4', config);

    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(config.burst);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('fails open without sending commands while Redis is disconnected', async () => {
    mockClient.isReady = false;

    const result = await service.checkRateLimit('ip:1.2.3.4', config);

    expect(result.allowed).toBe(true);
    expect(mockMulti).not.toHaveBeenCalled();
  });
});
