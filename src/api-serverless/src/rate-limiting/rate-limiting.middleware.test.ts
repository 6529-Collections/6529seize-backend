import { NextFunction, Request, Response } from 'express';
import * as jwt from 'jsonwebtoken';
import { getIp } from '../policies/policies';
import {
  clearConfigCache,
  rateLimitingMiddleware
} from './rate-limiting.middleware';
import { rateLimitingService } from './rate-limiting.service';
import {
  getRateLimitConfig,
  verifyInternalRequest
} from './rate-limiting.utils';

const mockJwtSecret = 'rate-limit-test-jwt-secret';
const WALLET = '0x123abc0000000000000000000000000000000def';

jest.mock('./rate-limiting.service');
jest.mock('../auth/auth', () => ({
  getJwtSecret: () => mockJwtSecret
}));
jest.mock('../policies/policies');
jest.mock('./rate-limiting.utils', () => ({
  ...jest.requireActual('./rate-limiting.utils'),
  getRateLimitConfig: jest.fn(),
  verifyInternalRequest: jest.fn()
}));

function bearer(
  sub: string,
  options: jwt.SignOptions = { expiresIn: 60 },
  secret: string = mockJwtSecret
): string {
  return `Bearer ${jwt.sign({ id: 'token-id', sub }, secret, options)}`;
}

function internalHeaders(signature: string): Record<string, string> {
  return {
    'x-6529-internal-id': '6529-SSR',
    'x-6529-internal-timestamp': Math.floor(Date.now() / 1000).toString(),
    'x-6529-internal-signature': signature
  };
}

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
      headers: {},
      method: 'GET',
      path: '/api/nfts',
      url: '/api/nfts'
    } as any;

    res = {
      setHeader: mockSetHeader,
      status: mockStatus,
      json: mockJson
    };

    next = jest.fn();

    (getIp as jest.Mock).mockReturnValue('192.168.1.1');
    (verifyInternalRequest as jest.Mock).mockReturnValue(false);
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 15,
      resetTime: Date.now() + 1000,
      limit: 20
    });
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
      sessionRefresh: {
        burst: 90,
        sustainedRps: 30,
        sustainedWindowSeconds: 10
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
      sessionRefresh: {
        burst: 90,
        sustainedRps: 30,
        sustainedWindowSeconds: 10
      },
      internal: {
        enabled: false,
        clientId: null,
        secret: null
      }
    });

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
  });

  it('uses the wallet from a valid Bearer access token', async () => {
    req.headers = { authorization: bearer(WALLET) };

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      `wallet:${WALLET}`,
      expect.objectContaining({
        burst: 30,
        sustainedRps: 10,
        sustainedWindowSeconds: 60
      })
    );
    expect(next).toHaveBeenCalled();
  });

  it('normalizes wallet address to lowercase', async () => {
    req.headers = {
      authorization: bearer(`0x${WALLET.slice(2).toUpperCase()}`)
    };

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      `wallet:${WALLET}`,
      expect.any(Object)
    );
  });

  it.each([
    ['an expired token', () => bearer(WALLET, { expiresIn: -10 })],
    [
      'a token signed with another secret',
      () => bearer(WALLET, { expiresIn: 60 }, 'other-secret')
    ],
    [
      'a token signed with another algorithm',
      () => bearer(WALLET, { expiresIn: 60, algorithm: 'HS512' })
    ],
    ['a token without a wallet subject', () => bearer('not-a-wallet')],
    ['a malformed token', () => 'Bearer not.a.jwt'],
    ['a non-Bearer scheme', () => 'Basic dXNlcjpwYXNz']
  ])(
    'falls back to the IP bucket with unauthenticated limits for %s',
    async (_, authorization) => {
      req.headers = { authorization: authorization() };

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
      expect(mockStatus).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    }
  );

  it('uses IP address when user is not authenticated', async () => {
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

  it('keys anonymous traffic on getIp and not on forwarding headers', async () => {
    req.headers = { 'x-forwarded-for': '198.51.100.66' };
    (req as any).ip = '198.51.100.66';

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(getIp).toHaveBeenCalledWith(req);
    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'ip:192.168.1.1',
      expect.any(Object)
    );
  });

  it('adds rate limit headers to response', async () => {
    req.headers = { authorization: bearer(WALLET) };
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
    req.headers = { authorization: bearer(WALLET) };
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
    (getIp as jest.Mock).mockReturnValue('');

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('handles errors gracefully and allows request (fail open)', async () => {
    req.headers = { authorization: bearer(WALLET) };
    (rateLimitingService.checkRateLimit as jest.Mock).mockRejectedValue(
      new Error('Redis error')
    );

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('skips rate limiting for verified internal requests (for server-side requests)', async () => {
    (verifyInternalRequest as jest.Mock).mockReturnValue(true);
    req.headers = internalHeaders('test-signature');

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

  it('verified internal request skips rate limiting even with a forwarded viewer Bearer token', async () => {
    (verifyInternalRequest as jest.Mock).mockReturnValue(true);
    req.headers = {
      ...internalHeaders('test-signature'),
      authorization: bearer(WALLET)
    };

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('falls back to IP when internal request verification fails', async () => {
    req.headers = internalHeaders('invalid-signature');

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'ip:192.168.1.1',
      expect.any(Object)
    );
  });

  it('falls back to the wallet when internal request verification fails', async () => {
    req.headers = {
      ...internalHeaders('invalid-signature'),
      authorization: bearer(WALLET)
    };

    const middleware = rateLimitingMiddleware();
    await middleware(req as Request, res as Response, next);

    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      `wallet:${WALLET}`,
      expect.objectContaining({ burst: 30 })
    );
  });

  it.each([
    '/api/auth/session-refresh',
    '/api/auth/session-refresh/',
    '/API/AUTH/SESSION-REFRESH'
  ])(
    'isolates refresh POST %s from exhausted ordinary traffic',
    async (path) => {
      (rateLimitingService.checkRateLimit as jest.Mock).mockImplementation(
        async (key: string) => ({
          allowed: key.startsWith('session-refresh:'),
          remaining: 0,
          limit: 30,
          resetTime: Date.now() + 1000
        })
      );
      req = { headers: {}, method: 'GET', path: '/api/notifications' };
      await rateLimitingMiddleware()(req as Request, res as Response, next);
      expect(mockStatus).toHaveBeenCalledWith(429);
      req = { headers: {}, method: 'POST', path };
      await rateLimitingMiddleware()(req as Request, res as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(rateLimitingService.checkRateLimit).toHaveBeenLastCalledWith(
        'session-refresh:ip:192.168.1.1',
        { burst: 90, sustainedRps: 30, sustainedWindowSeconds: 10 }
      );
      expect(mockSetHeader).not.toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        '*'
      );
    }
  );

  it.each([
    ['GET', '/api/auth/session-refresh'],
    ['POST', '/api/auth/session-login'],
    ['POST', '/api/auth/session-refresh/other']
  ])('does not give %s %s the refresh allowance', async (method, path) => {
    (rateLimitingService.checkRateLimit as jest.Mock).mockResolvedValue({
      allowed: true,
      remaining: 1,
      limit: 20,
      resetTime: Date.now() + 1000
    });
    req = { headers: {}, method, path };
    await rateLimitingMiddleware()(req as Request, res as Response, next);
    expect(rateLimitingService.checkRateLimit).toHaveBeenCalledWith(
      'ip:192.168.1.1',
      expect.objectContaining({ burst: 20 })
    );
  });
});
