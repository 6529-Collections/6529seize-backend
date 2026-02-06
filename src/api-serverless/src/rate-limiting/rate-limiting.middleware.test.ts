import { NextFunction, Request, Response } from 'express';
import { getAuthenticatedWalletOrNull } from '../auth/auth';
import { getIp } from '../policies/policies';
import { clearConfigCache } from './rate-limiting.middleware';
import { rateLimitingService } from './rate-limiting.service';
import {
  getRateLimitConfig,
  verifyInternalRequest
} from './rate-limiting.utils';

jest.mock('./rate-limiting.service');
jest.mock('../auth/auth');
jest.mock('../policies/policies');
jest.mock('./rate-limiting.utils', () => ({
  ...jest.requireActual('./rate-limiting.utils'),
  getRateLimitConfig: jest.fn(),
  verifyInternalRequest: jest.fn()
}));

describe('rateLimitingMiddleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let mockSetHeader: jest.Mock;
  let mockStatus: jest.Mock;
  let mockJson: jest.Mock;

  beforeEach(() => {
    clearConfigCache(); // Clear cache before each test
    mockSetHeader = jest.fn();
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });

    req = {
      user: undefined,
      ip: '192.168.1.1'
    } as any;

    res = {
      setHeader: mockSetHeader,
      status: mockStatus,
      json: mockJson
    };

    next = jest.fn();

    (getRateLimitConfig as jest.Mock).mockReturnValue({
      enabled: true,
      authenticated: {
        burst: 30,
        sustainedRps: 10,
        sustainedWindowSeconds: 60
      },
      unauthenticated: {
        burst: 20,
        sustainedRps: 5,
        sustainedWindowSeconds: 60
      },
      internal: {
        enabled: true,
        clientId: 'test-id',
        secret: 'test-secret'
      }
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('skips rate limiting when disabled', async () => {
    clearConfigCache();
    (getRateLimitConfig as jest.Mock).mockReturnValue({
      enabled: false,
      authenticated: {},
      unauthenticated: {},
      internal: {
        enabled: false,
        clientId: null,
        secret: null
      }
    });

    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
  });

  it('uses authenticated wallet when available', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue('0x123abc');
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 25,
      resetTime: Date.now() + 1000,
      limit: 30
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(getAuthenticatedWalletOrNull).toHaveBeenCalledWith(req);
    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'wallet:0x123abc',
      expect.objectContaining({
        burst: 30,
        sustainedRps: 10,
        sustainedWindowSeconds: 60
      })
    );
    expect(next).toHaveBeenCalled();
  });

  it('uses IP address when user is not authenticated', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(null);
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 15,
      resetTime: Date.now() + 1000,
      limit: 20
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'ip:192.168.1.1',
      expect.objectContaining({
        burst: 20,
        sustainedRps: 5,
        sustainedWindowSeconds: 60
      })
    );
    expect(next).toHaveBeenCalled();
  });

  it('adds rate limit headers to response', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue('0x123abc');
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    const resetTime = Date.now() + 5000;
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 25,
      resetTime: resetTime,
      limit: 30
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(mockSetHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '30');
    expect(mockSetHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '25');
    expect(mockSetHeader).toHaveBeenCalledWith(
      'X-RateLimit-Reset',
      Math.ceil(resetTime / 1000).toString()
    );
    expect(next).toHaveBeenCalled();
  });

  it('returns 429 when rate limit is exceeded', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue('0x123abc');
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    const resetTime = Date.now() + 5000;
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetTime: resetTime,
      limit: 30
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(mockSetHeader).toHaveBeenCalledWith(
      'Retry-After',
      expect.any(String)
    );
    expect(mockStatus).toHaveBeenCalledWith(429);
    expect(mockJson).toHaveBeenCalledWith({
      error: 'Rate limit exceeded',
      message: 'Too many requests, please try again later',
      retryAfter: expect.any(Number),
      source: '6529-api'
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows request when identifier cannot be determined', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(null);
    (getIp as jest.Mock).mockReturnValue('');

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('handles errors gracefully and allows request (fail open)', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue('0x123abc');
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (rateLimitingService.checkRateLimit as jest.Mock).mockRejectedValue(
      new Error('Redis error')
    );

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('normalizes wallet address to lowercase', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue('0xABC123');
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 25,
      resetTime: Date.now() + 1000,
      limit: 30
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'wallet:0xabc123',
      expect.any(Object)
    );
  });

  it('skips rate limiting for verified internal requests (for server-side requests)', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(null);
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (verifyInternalRequest as jest.Mock).mockReturnValue(true);
    req.headers = {
      'x-6529-internal-id': '6529-SSR',
      'x-6529-internal-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-6529-internal-signature': 'test-signature'
    };
    req.method = 'GET';
    (req.path as any) = '/api/nfts';

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(verifyInternalRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        enabled: true,
        clientId: 'test-id',
        secret: 'test-secret'
      })
    );
    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('internal request skips rate limiting and takes priority over IP address', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(null);
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (verifyInternalRequest as jest.Mock).mockReturnValue(true);
    req.headers = {
      'x-6529-internal-id': '6529-SSR',
      'x-6529-internal-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-6529-internal-signature': 'test-signature'
    };
    req.method = 'GET';
    (req.path as any) = '/api/nfts';

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('authenticated wallet takes priority over internal request', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue('0x123abc');
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (verifyInternalRequest as jest.Mock).mockReturnValue(true);
    req.headers = {
      'x-6529-internal-id': '6529-SSR',
      'x-6529-internal-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-6529-internal-signature': 'test-signature'
    };
    req.method = 'GET';
    (req.path as any) = '/api/nfts';
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 25,
      resetTime: Date.now() + 1000,
      limit: 30
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'wallet:0x123abc',
      expect.objectContaining({
        burst: 30,
        sustainedRps: 10,
        sustainedWindowSeconds: 60
      })
    );
    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalledWith(
      expect.stringContaining('internal:'),
      expect.any(Object)
    );
  });

  it('internal request skips rate limiting when wallet is not authenticated', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(null);
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (verifyInternalRequest as jest.Mock).mockReturnValue(true);
    req.headers = {
      'x-6529-internal-id': '6529-SSR',
      'x-6529-internal-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-6529-internal-signature': 'test-signature'
    };
    req.method = 'GET';
    (req.path as any) = '/api/nfts';

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('falls back to IP when internal request verification fails', async () => {
    const { rateLimitingMiddleware } = require('./rate-limiting.middleware');
    (getAuthenticatedWalletOrNull as jest.Mock).mockReturnValue(null);
    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (verifyInternalRequest as jest.Mock).mockReturnValue(false);
    req.headers = {
      'x-6529-internal-id': '6529-SSR',
      'x-6529-internal-timestamp': Math.floor(Date.now() / 1000).toString(),
      'x-6529-internal-signature': 'invalid-signature'
    };
    req.method = 'GET';
    (req.path as any) = '/api/nfts';
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 15,
      resetTime: Date.now() + 1000,
      limit: 20
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'ip:192.168.1.1',
      expect.any(Object)
    );
  });
});
