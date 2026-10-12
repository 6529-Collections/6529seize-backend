import axios from 'axios';
import express from 'express';
import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const mockSign = jest.fn();

jest.mock('aws4', () => ({
  sign: (opts: { headers: Record<string, unknown> }) => mockSign(opts)
}));

jest.mock('axios', () => ({
  __esModule: true,
  default: { post: jest.fn() }
}));

import rpcRoutes, {
  RPC_MAX_RESPONSE_BYTES,
  RPC_MAX_UPSTREAM_RESPONSE_BYTES,
  RPC_UPSTREAM_TIMEOUT_MS
} from './rpc.routes';
import {
  RPC_ALLOWED_METHOD_LIST,
  RPC_MAX_BATCH_SIZE,
  RPC_MAX_REQUEST_BYTES
} from './rpc-request-validation';

const mockPost = axios.post as unknown as jest.Mock;

const UPSTREAM_ORIGIN =
  'https://nd-zpz7imf76bhw3cdjdkwwaghq4e.ethereum.managedblockchain.us-east-1.amazonaws.com';

async function listen(withJsonParser: boolean) {
  const app = express();
  if (withJsonParser) {
    app.use(express.json({ limit: '5mb' }));
  }
  app.use('/rpc', rpcRoutes);
  const started = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    server: started,
    url: `http://127.0.0.1:${(started.address() as AddressInfo).port}`
  };
}

function close(server: Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

const INVALID_REQUEST = 'Invalid Request';
const METHOD_NOT_FOUND = 'Method not found';
const UPSTREAM_ERROR = 'Upstream RPC error';

let server: Server;
let baseUrl: string;
let bareServer: Server;
let bareUrl: string;

beforeAll(async () => {
  ({ server, url: baseUrl } = await listen(true));
  ({ server: bareServer, url: bareUrl } = await listen(false));
});

afterAll(async () => {
  await close(server);
  await close(bareServer);
});

beforeEach(() => {
  mockPost.mockReset();
  mockSign.mockReset();
  mockSign.mockImplementation((opts: { headers: Record<string, unknown> }) => {
    opts.headers.Authorization = 'AWS4-HMAC-SHA256 signed-for-test';
  });
  mockPost.mockImplementation(async (_url: string, body: string) => ({
    data: { jsonrpc: '2.0', id: JSON.parse(body).id, result: '0x1' }
  }));
});

function rpcCall(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_blockNumber',
    params: [],
    ...overrides
  };
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function send(path: string, init: RequestInit = {}, origin = baseUrl) {
  const response = await fetch(`${origin}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: parseJson(text)
  };
}

function post(body: unknown, path = '/rpc') {
  return send(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

describe('POST /rpc', () => {
  it('forwards an allowlisted call with signing, timeout and size bounds', async () => {
    const response = await post(
      rpcCall({
        id: 'req-1',
        method: 'eth_getBalance',
        params: ['0xabc', 'latest']
      })
    );

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: '0x1'
    });
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [url, body, options] = mockPost.mock.calls[0];
    expect(url).toBe(UPSTREAM_ORIGIN);
    expect(JSON.parse(body)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'eth_getBalance',
      params: ['0xabc', 'latest']
    });
    expect(options).toMatchObject({
      timeout: RPC_UPSTREAM_TIMEOUT_MS,
      maxContentLength: RPC_MAX_UPSTREAM_RESPONSE_BYTES,
      maxBodyLength: RPC_MAX_REQUEST_BYTES,
      maxRedirects: 0
    });
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSign.mock.calls[0][0]).toMatchObject({
      host: new URL(UPSTREAM_ORIGIN).hostname,
      path: '/',
      service: 'managedblockchain',
      region: 'us-east-1',
      method: 'POST',
      body
    });
    expect(options.headers.Authorization).toBe(
      'AWS4-HMAC-SHA256 signed-for-test'
    );
  });

  it('only forwards known request fields', async () => {
    await post(rpcCall({ extra: 'x', headers: { a: 'b' } }));
    expect(
      Object.keys(JSON.parse(mockPost.mock.calls[0][1])).sort((a, b) =>
        a.localeCompare(b)
      )
    ).toEqual(['id', 'jsonrpc', 'method', 'params']);
  });

  it('uses the caller id even when the node answers with another one', async () => {
    mockPost.mockResolvedValue({
      data: { jsonrpc: '2.0', id: 999, result: '0x2' }
    });
    const response = await post(rpcCall({ id: 5 }));
    expect(response.json).toEqual({ jsonrpc: '2.0', id: 5, result: '0x2' });
  });

  it.each([
    'eth_sendRawTransaction',
    'debug_traceTransaction',
    'trace_block',
    'admin_peers',
    'personal_unlockAccount',
    'txpool_content',
    'eth_subscribe',
    'eth_getLogs'
  ])('answers %s locally without calling the node', async (method) => {
    const response = await post(rpcCall({ id: 11, method }));
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: 11,
      error: { code: -32601, message: METHOD_NOT_FOUND }
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('accepts every allowlisted method', async () => {
    for (const method of RPC_ALLOWED_METHOD_LIST) {
      const response = await post(rpcCall({ method }));
      expect(response.json.result).toBe('0x1');
    }
    expect(mockPost).toHaveBeenCalledTimes(RPC_ALLOWED_METHOD_LIST.length);
  });

  it.each([
    ['a jsonrpc version', { jsonrpc: '1.0' }, -32600],
    ['a non-string method', { method: 7 }, -32600],
    ['object params', { params: { a: 1 } }, -32602]
  ])('reports invalid shape for %s', async (_label, override, code) => {
    const response = await post(rpcCall({ id: 4, ...override }));
    expect(response.status).toBe(200);
    expect(response.json.id).toBe(4);
    expect(response.json.error.code).toBe(code);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('treats a non-JSON content type as an invalid request', async () => {
    const response = await send('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(rpcCall())
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: INVALID_REQUEST }
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects a request with no parsed body', async () => {
    const response = await send(
      '/rpc',
      { method: 'POST', body: 'ignored' },
      bareUrl
    );
    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: INVALID_REQUEST }
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects top-level JSON primitives before reaching the proxy', async () => {
    for (const body of ['"eth_chainId"', '5', 'null']) {
      const response = await post(body);
      expect(response.status).toBe(400);
    }
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects an oversized request before contacting the node', async () => {
    const response = await post(
      rpcCall({
        method: 'eth_call',
        params: ['0x' + '00'.repeat(RPC_MAX_REQUEST_BYTES)]
      })
    );
    expect(response.status).toBe(413);
    expect(response.json.error.code).toBe(-32600);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON without contacting the node', async () => {
    const response = await send('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":'
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockPost).not.toHaveBeenCalled();
  });
});

describe('batches', () => {
  it(`accepts up to ${RPC_MAX_BATCH_SIZE} calls and keeps their order`, async () => {
    const batch = Array.from({ length: RPC_MAX_BATCH_SIZE }, (_, index) =>
      rpcCall({ id: index })
    );
    const response = await post(batch);
    expect(response.status).toBe(200);
    expect(response.json.map((entry: { id: number }) => entry.id)).toEqual(
      batch.map((entry) => entry.id)
    );
    expect(mockPost).toHaveBeenCalledTimes(RPC_MAX_BATCH_SIZE);
  });

  it(`rejects more than ${RPC_MAX_BATCH_SIZE} calls without contacting the node`, async () => {
    const batch = Array.from({ length: RPC_MAX_BATCH_SIZE + 1 }, (_, index) =>
      rpcCall({ id: index })
    );
    const response = await post(batch);
    expect(response.status).toBe(400);
    expect(response.json.id).toBeNull();
    expect(response.json.error.code).toBe(-32600);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('rejects an empty batch', async () => {
    const response = await post([]);
    expect(response.status).toBe(400);
    expect(response.json.error.code).toBe(-32600);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('answers each entry independently and forwards only valid ones', async () => {
    const response = await post([
      rpcCall({ id: 1 }),
      rpcCall({ id: 2, method: 'debug_traceTransaction' }),
      'not-an-object',
      rpcCall({ id: 4, method: 'eth_chainId' })
    ]);
    expect(response.status).toBe(200);
    expect(response.json).toEqual([
      { jsonrpc: '2.0', id: 1, result: '0x1' },
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32601, message: METHOD_NOT_FOUND }
      },
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: INVALID_REQUEST }
      },
      { jsonrpc: '2.0', id: 4, result: '0x1' }
    ]);
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('rejects a batch whose assembled response would be too large', async () => {
    const chunk =
      '0x' + '11'.repeat(RPC_MAX_UPSTREAM_RESPONSE_BYTES / 2 - 1024);
    mockPost.mockImplementation(async (_url: string, body: string) => ({
      data: { jsonrpc: '2.0', id: JSON.parse(body).id, result: chunk }
    }));
    const calls = Math.ceil(RPC_MAX_RESPONSE_BYTES / chunk.length) + 1;
    const response = await post(
      Array.from({ length: calls }, (_, index) => rpcCall({ id: index }))
    );
    expect(response.status).toBe(413);
    expect(response.json.error.code).toBe(-32005);
  });
});

describe('upstream failures', () => {
  it('returns a generic error and never echoes the upstream body', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 403'), {
        code: 'ERR_BAD_REQUEST',
        response: {
          status: 403,
          data: {
            message: 'arn:aws:sts::123456789012:assumed-role/secret-role'
          }
        }
      })
    );
    const response = await post(rpcCall({ id: 'x' }));
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      error: { code: -32603, message: UPSTREAM_ERROR }
    });
    expect(response.text).not.toContain('arn:aws');
    expect(response.text).not.toContain('403');
  });

  it('reports a timed out call as a generic error', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('timeout of 10000ms exceeded'), {
        code: 'ECONNABORTED'
      })
    );
    const response = await post([rpcCall({ id: 1 }), rpcCall({ id: 2 })]);
    expect(response.json).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: UPSTREAM_ERROR }
      },
      {
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32603, message: UPSTREAM_ERROR }
      }
    ]);
  });

  it('keeps a successful call when a sibling call fails', async () => {
    mockPost.mockImplementation(async (_url: string, body: string) => {
      const { id } = JSON.parse(body);
      if (id === 2) {
        throw new Error('boom');
      }
      return { data: { jsonrpc: '2.0', id, result: '0x1' } };
    });
    const response = await post([rpcCall({ id: 1 }), rpcCall({ id: 2 })]);
    expect(response.json[0]).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' });
    expect(response.json[1].error.code).toBe(-32603);
  });

  it('passes through only code, message and hex data of a node error', async () => {
    mockPost.mockResolvedValue({
      data: {
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: 3,
          message: 'execution reverted',
          data: '0x08c379a0',
          trace: 'internal-detail',
          url: 'https://internal.example'
        }
      }
    });
    const response = await post(rpcCall({ method: 'eth_call' }));
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: 3, message: 'execution reverted', data: '0x08c379a0' }
    });
  });

  it('drops non-hex error data and truncates long messages', async () => {
    mockPost.mockResolvedValue({
      data: {
        error: {
          code: -32000,
          message: 'm'.repeat(1000),
          data: 'not hex <secret>'
        }
      }
    });
    const response = await post(rpcCall());
    expect(response.json.error.code).toBe(-32000);
    expect(response.json.error.message).toHaveLength(256);
    expect(response.json.error).not.toHaveProperty('data');
  });

  it.each([
    ['a string body', '<html>gateway error</html>'],
    ['an empty body', undefined],
    ['an object without result or error', { jsonrpc: '2.0', id: 1 }],
    ['a malformed error', { error: 'plain string error with arn:aws:secret' }],
    ['an error without a numeric code', { error: { message: 'x' } }]
  ])('maps %s to a generic error', async (_label, data) => {
    mockPost.mockResolvedValue({ data });
    const response = await post(rpcCall({ id: 9 }));
    expect(response.json).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32603, message: UPSTREAM_ERROR }
    });
  });
});

describe('route surface', () => {
  it.each([
    ['GET', '/rpc'],
    ['GET', '/rpc/test'],
    ['PUT', '/rpc'],
    ['DELETE', '/rpc'],
    ['POST', '/rpc/test'],
    ['POST', '/rpc/some/extra/path']
  ])('does not serve %s %s', async (method, path) => {
    const response = await send(path, {
      method,
      ...(method === 'POST' || method === 'PUT'
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rpcCall())
          }
        : {})
    });
    expect(response.status).toBe(404);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('serves POST with a trailing slash', async () => {
    const response = await post(rpcCall(), '/rpc/');
    expect(response.status).toBe(200);
  });
});
