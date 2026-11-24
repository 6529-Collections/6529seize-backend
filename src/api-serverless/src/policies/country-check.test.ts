import axios from 'axios';
import express from 'express';
import * as mcache from 'memory-cache';
import policiesRouter from './policies.routes';

jest.mock('axios');
jest.mock('./policies.db');
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: jest.fn() }) }
}));

const serverlessHttp = require('serverless-http');

describe('GET /policies/country-check through serverless-http', () => {
  const originalTrust = process.env.TRUST_WAF_COUNTRY_HEADER;
  const mockedGet = jest.mocked(axios.get);
  const app = express();
  app.use('/api/policies', policiesRouter);
  const handler = serverlessHttp(app);

  function gatewayEvent(
    headers: Record<string, string> = {},
    ip = '203.0.113.10'
  ) {
    return {
      httpMethod: 'GET',
      path: '/api/policies/country-check',
      headers,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body: null,
      isBase64Encoded: false,
      requestContext: {
        requestId: 'country-check-request',
        identity: { sourceIp: ip }
      }
    };
  }

  beforeEach(() => {
    process.env.TRUST_WAF_COUNTRY_HEADER = 'true';
    mockedGet.mockReset();
    mockedGet.mockResolvedValue({
      data: { country: { iso_code: 'US' } }
    });
  });

  afterEach(() => {
    mcache.clear();
    if (originalTrust === undefined) {
      delete process.env.TRUST_WAF_COUNTRY_HEADER;
    } else {
      process.env.TRUST_WAF_COUNTRY_HEADER = originalTrust;
    }
  });

  it.each([
    ['CY', true],
    ['NO', true],
    ['US', false]
  ])('uses WAF country %s without calling FindIP', async (country, isEu) => {
    const response = await handler(
      gatewayEvent({ 'X-Amzn-Waf-Country': String(country) }),
      {}
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ is_eu: isEu, country });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'XX', 'ZZ', 'AA', 'EU', 'cy', 'CY, US'])(
    'falls back to FindIP for WAF value %p',
    async (country) => {
      const headers: Record<string, string> =
        country === undefined ? {} : { 'x-amzn-waf-country': country };
      const response = await handler(gatewayEvent(headers), {});

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        is_eu: false,
        country: 'US'
      });
      expect(mockedGet).toHaveBeenCalledTimes(1);
      const url = new URL(mockedGet.mock.calls[0][0]);
      expect(url.pathname).toBe('/203.0.113.10/');
      expect(mockedGet.mock.calls[0][1]).toEqual({ timeout: 3000 });
    }
  );

  it('rejects duplicate country headers from a REST API event', async () => {
    const response = await handler(
      {
        ...gatewayEvent({ 'x-amzn-waf-country': 'CY' }),
        multiValueHeaders: { 'x-amzn-waf-country': ['CY', 'US'] }
      },
      {}
    );

    expect(JSON.parse(response.body)).toEqual({ is_eu: false, country: 'US' });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('accepts an agreeing single value in both gateway header maps', async () => {
    const response = await handler(
      {
        ...gatewayEvent({ 'X-Amzn-Waf-Country': 'CY' }),
        multiValueHeaders: { 'X-Amzn-Waf-Country': ['CY'] }
      },
      {}
    );

    expect(JSON.parse(response.body)).toEqual({ is_eu: true, country: 'CY' });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('rejects conflicting single and multi-value gateway headers', async () => {
    const response = await handler(
      {
        ...gatewayEvent({ 'x-amzn-waf-country': 'CY' }),
        multiValueHeaders: { 'x-amzn-waf-country': ['US'] }
      },
      {}
    );

    expect(JSON.parse(response.body)).toEqual({ is_eu: false, country: 'US' });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('ignores a spoofable country header before the environment opts in', async () => {
    delete process.env.TRUST_WAF_COUNTRY_HEADER;
    const response = await handler(
      gatewayEvent({ 'x-amzn-waf-country': 'CY' }),
      {}
    );

    expect(JSON.parse(response.body)).toEqual({ is_eu: false, country: 'US' });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('retains the FindIP cache when the WAF value is missing', async () => {
    await handler(gatewayEvent(), {});
    const response = await handler(gatewayEvent(), {});

    expect(JSON.parse(response.body)).toEqual({ is_eu: false, country: 'US' });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('retains the existing failure response when FindIP also fails', async () => {
    mockedGet.mockRejectedValue(new Error('timeout of 3000ms exceeded'));
    const response = await handler(gatewayEvent(), {});

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      message: 'Failed to get country from IP address'
    });
  });

  it('retains the localhost response without a provider call', async () => {
    const response = await handler(
      gatewayEvent({ 'x-amzn-waf-country': 'US' }, '127.0.0.1'),
      {}
    );

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ is_eu: true, country: null });
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('retains source-IP validation even when a country header is present', async () => {
    const response = await handler(
      gatewayEvent({ 'x-amzn-waf-country': 'CY' }, 'invalid-ip'),
      {}
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({
      message: 'Failed to get IP address'
    });
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
