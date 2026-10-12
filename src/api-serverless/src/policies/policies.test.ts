import axios from 'axios';
import express, { Request } from 'express';
import * as fc from 'fast-check';
import * as mcache from 'memory-cache';
import * as http from 'node:http';
import { AddressInfo, isIP } from 'node:net';
import { getIp, getIpInfo, normalizeIp } from './policies';

jest.mock('axios');

const serverlessHttp = require('serverless-http');

const SPOOFED_IP = '198.51.100.66';

function requestWith(fields: Record<string, unknown>): Request {
  return { headers: {}, ...fields } as unknown as Request;
}

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.10', '203.0.113.10'],
    ['2001:db8::1', '2001:db8::1'],
    ['::1', '::1'],
    ['::ffff:203.0.113.10', '203.0.113.10'],
    ['::FFFF:192.0.2.1', '192.0.2.1']
  ])('accepts %p as %p', (value, expected) => {
    expect(normalizeIp(value)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'unknown',
    'test-invoke-source-ip',
    '203.0.113.10, 192.0.2.8',
    '203.0.113.10:443',
    ' 203.0.113.10',
    '203.0.113.10/../../x',
    'fe80::1%eth0',
    '999.1.1.1'
  ])('rejects %p', (value) => {
    expect(normalizeIp(value)).toBe('');
  });

  it('only ever returns a plain IP literal', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.ipV4(), fc.ipV6()), (value) => {
        const normalized = normalizeIp(value);
        if (normalized) {
          expect(isIP(normalized)).not.toBe(0);
          expect(normalized).toMatch(/^[0-9a-f.:]+$/i);
        }
      })
    );
  });
});

describe('getIp', () => {
  it('uses the REST API Gateway source IP and ignores forwarding headers', () => {
    const req = requestWith({
      headers: { 'x-forwarded-for': `${SPOOFED_IP}, 203.0.113.10` },
      ip: SPOOFED_IP,
      requestContext: { identity: { sourceIp: '203.0.113.10' } },
      socket: { remoteAddress: '192.0.2.99' }
    });

    expect(getIp(req)).toBe('203.0.113.10');
  });

  it('uses the HTTP API source IP', () => {
    const req = requestWith({
      requestContext: { http: { sourceIp: '2001:db8::1' } }
    });

    expect(getIp(req)).toBe('2001:db8::1');
  });

  it('falls back to the socket peer outside API Gateway', () => {
    const req = requestWith({
      headers: { 'x-forwarded-for': SPOOFED_IP },
      ip: SPOOFED_IP,
      socket: { remoteAddress: '::ffff:127.0.0.1' }
    });

    expect(getIp(req)).toBe('127.0.0.1');
  });

  it('returns an empty string when the source is not a valid IP', () => {
    const req = requestWith({
      requestContext: { identity: { sourceIp: 'test-invoke-source-ip' } }
    });

    expect(getIp(req)).toBe('');
  });

  it('ignores a spoofed X-Forwarded-For behind serverless-http even when Express trusts proxies', async () => {
    const app = express();
    app.enable('trust proxy');
    app.get('/ip', (req, res) => {
      res.json({ ip: getIp(req) });
    });
    const handler = serverlessHttp(app);

    const response = await handler(
      {
        httpMethod: 'GET',
        path: '/ip',
        headers: { 'X-Forwarded-For': `${SPOOFED_IP}, 203.0.113.10` },
        multiValueHeaders: {
          'X-Forwarded-For': [`${SPOOFED_IP}, 203.0.113.10`]
        },
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        body: null,
        isBase64Encoded: false,
        requestContext: {
          requestId: 'request-id',
          identity: { sourceIp: '203.0.113.10' }
        }
      },
      {}
    );

    expect(JSON.parse(response.body)).toEqual({ ip: '203.0.113.10' });
  });

  it('ignores a spoofed X-Forwarded-For on the local server even when Express trusts proxies', async () => {
    const app = express();
    app.enable('trust proxy');
    app.get('/ip', (req, res) => {
      res.json({ ip: getIp(req) });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(
            {
              host: '127.0.0.1',
              port,
              path: '/ip',
              agent: false,
              headers: { 'X-Forwarded-For': SPOOFED_IP }
            },
            (res) => {
              let data = '';
              res.on('data', (chunk) => (data += chunk));
              res.on('end', () => resolve(data));
            }
          )
          .on('error', reject);
      });

      expect(JSON.parse(body)).toEqual({ ip: '127.0.0.1' });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('getIpInfo', () => {
  const mockedGet = axios.get as jest.Mock;

  beforeEach(() => {
    mockedGet.mockReset();
    process.env.FINDIP_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    // Drops cached entries and their expiry timers.
    mcache.clear();
  });

  it.each([
    '',
    'not-an-ip',
    '203.0.113.10/../../admin',
    '203.0.113.10?x=1',
    '::1%eth0'
  ])('does not call the lookup service for %p', async (ip) => {
    await expect(getIpInfo(ip)).resolves.toBeNull();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('builds the lookup URL from the validated IP only', async () => {
    mockedGet.mockResolvedValue({ data: {} });

    await getIpInfo('2001:db8::42');

    const url = new URL(mockedGet.mock.calls[0][0]);
    expect(url.origin).toBe('https://api.findip.net');
    expect(url.pathname).toBe('/2001:db8::42/');
    expect(url.searchParams.get('token')).toBe('test-token');
  });

  it('returns the same shape on a cache hit as on a lookup', async () => {
    mockedGet.mockResolvedValue({
      data: {
        city: { names: { en: 'Berlin' } },
        country: { iso_code: 'DE', names: { en: 'Germany' } }
      }
    });
    const expected = {
      city_name: 'Berlin',
      country_name: 'Germany',
      country: 'DE'
    };

    await expect(getIpInfo('203.0.113.7')).resolves.toEqual(expected);
    await expect(getIpInfo('203.0.113.7')).resolves.toEqual(expected);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });
});
