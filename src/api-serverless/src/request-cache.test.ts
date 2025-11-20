import EventEmitter from 'events';
import { cacheRequest } from './request-cache';
import { cacheKey } from './api-helpers';
import { Request, Response } from 'express';
import { redisGet, redisSetJson } from '../../redis';

jest.mock('../../redis', () => ({
  redisGet: jest.fn(),
  redisSetJson: jest.fn()
}));

const mockedRedisGet = redisGet as jest.MockedFunction<typeof redisGet>;
const mockedRedisSetJson = redisSetJson as jest.MockedFunction<
  typeof redisSetJson
>;

describe('cacheRequest auth dependency', () => {
  beforeEach(() => {
    mockedRedisGet.mockReset().mockResolvedValue(null);
    mockedRedisSetJson.mockReset().mockResolvedValue(undefined as any);
  });

  it('does not change cache key when authDependent is false', async () => {
    const middleware = cacheRequest();
    const req = createRequest({
      originalUrl: '/blocks',
      headers: { authorization: 'Bearer token-123' }
    });
    const res = createResponse();

    await middleware(req as Request, res as Response, async () => {
      res.status(200);
      res.end();
    });
    await flushPromises();

    const expectedKey = cacheKey(req as Request);
    expect(mockedRedisGet).toHaveBeenCalledWith(expectedKey);
    expect(mockedRedisSetJson).toHaveBeenCalledWith(
      expectedKey,
      expect.objectContaining({ statusCode: 200 }),
      expect.anything()
    );
  });

  it('appends authorization header when authDependent is true', async () => {
    const middleware = cacheRequest({ authDependent: true });
    const authHeader = 'Bearer token-456';
    const req = createRequest({
      originalUrl: '/blocks',
      headers: { authorization: authHeader }
    });
    const res = createResponse();

    await middleware(req as Request, res as Response, async () => {
      res.status(200);
      res.end(Buffer.from('payload'));
    });
    await flushPromises();

    const expectedKey = `${cacheKey(req as Request)}__AUTH__${authHeader}`;
    expect(mockedRedisGet).toHaveBeenCalledWith(expectedKey);
    expect(mockedRedisSetJson).toHaveBeenCalledWith(
      expectedKey,
      expect.objectContaining({ body: expect.any(String) }),
      expect.anything()
    );
  });

  it('uses anonymous cache key when no jwt present', async () => {
    const middleware = cacheRequest({ authDependent: true });
    const req = createRequest({
      originalUrl: '/blocks',
      headers: {}
    });
    const res = createResponse();

    await middleware(req as Request, res as Response, async () => {
      res.status(200);
      res.end();
    });
    await flushPromises();

    const expectedKey = `${cacheKey(req as Request)}__AUTH__anonymous`;
    expect(mockedRedisGet).toHaveBeenCalledWith(expectedKey);
    expect(mockedRedisSetJson).toHaveBeenCalledWith(
      expectedKey,
      expect.anything(),
      expect.anything()
    );
  });

  it('caches 304 responses by default', async () => {
    const middleware = cacheRequest({ authDependent: true });
    const req = createRequest({
      originalUrl: '/identity/punk6529',
      headers: { authorization: 'Bearer abc' }
    });
    const res = createResponse();

    await middleware(req as Request, res as Response, async () => {
      res.status(304);
      res.end();
    });
    await flushPromises();

    expect(mockedRedisSetJson).toHaveBeenCalledWith(
      `${cacheKey(req as Request)}__AUTH__Bearer abc`,
      expect.objectContaining({ statusCode: 304 }),
      expect.anything()
    );
  });
});

function createRequest({
  method = 'GET',
  originalUrl = '/test',
  headers = {}
}: Partial<Request> & { headers?: Record<string, string> }) {
  return {
    method,
    originalUrl,
    url: originalUrl,
    headers
  } as unknown as Request;
}

function createResponse() {
  class MockResponse extends EventEmitter {
    statusCode = 200;
    headers: Record<string, string | number | string[]> = {};

    status = jest.fn((code: number) => {
      this.statusCode = code;
      return this;
    });

    write = jest.fn(() => true);

    end = jest.fn(() => {
      this.emit('finish');
      return this;
    });

    send = jest.fn(() => {
      this.emit('finish');
      return this;
    });

    getHeaders = jest.fn(() => this.headers);

    setHeader = jest.fn(
      (key: string, value: string | number | readonly string[]) => {
        this.headers[key] = value as string | number | string[];
      }
    );
  }

  return new MockResponse() as unknown as Response;
}

function flushPromises() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
