import axios from 'axios';
import express from 'express';
import policiesRoutes from './policies.routes';

jest.mock('axios');
jest.mock('./policies.db', () => ({
  saveCookiesConsent: jest.fn(),
  deleteCookiesConsent: jest.fn()
}));

const serverlessHttp = require('serverless-http');

const EDGE_SECRET = 'edge-secret-for-country-check-tests';

async function countryCheck(
  headers: Record<string, string>,
  sourceIp = '203.0.113.50'
) {
  const app = express();
  app.use('/api/policies', policiesRoutes);
  const response = await serverlessHttp(app)(
    {
      httpMethod: 'GET',
      path: '/api/policies/country-check',
      headers,
      multiValueHeaders: Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, [value]])
      ),
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body: null,
      isBase64Encoded: false,
      requestContext: { requestId: 'request-id', identity: { sourceIp } }
    },
    {}
  );
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

describe('GET /policies/country-check without findip.net', () => {
  beforeEach(() => {
    process.env.TELEMETRY_EDGE_SECRET = EDGE_SECRET;
    (axios.get as jest.Mock).mockReset();
  });

  afterAll(() => {
    delete process.env.TELEMETRY_EDGE_SECRET;
  });

  it('answers from the trusted CloudFront viewer country', async () => {
    await expect(
      countryCheck({
        'x-6529-edge-auth': EDGE_SECRET,
        'cloudfront-viewer-country': 'US'
      })
    ).resolves.toEqual({ status: 200, body: { is_eu: false, country: 'US' } });
    await expect(
      countryCheck({
        'x-6529-edge-auth': EDGE_SECRET,
        'cloudfront-viewer-country': 'DE'
      })
    ).resolves.toEqual({ status: 200, body: { is_eu: true, country: 'DE' } });
  });

  it('keeps the old failure answer when the country is unknown (fail closed)', async () => {
    const failed = { status: 400, body: { message: 'Failed to get country' } };
    // A direct API call, even one claiming a country, cannot be located.
    await expect(
      countryCheck({ 'cloudfront-viewer-country': 'US' })
    ).resolves.toEqual(failed);
    await expect(
      countryCheck({
        'x-6529-edge-auth': EDGE_SECRET,
        'cloudfront-viewer-country': 'XX'
      })
    ).resolves.toEqual(failed);
  });

  it('keeps the local-development answer for localhost', async () => {
    await expect(countryCheck({}, '127.0.0.1')).resolves.toEqual({
      status: 200,
      body: { is_eu: true, country: null }
    });
  });

  it('never calls a third-party IP lookup', async () => {
    await countryCheck({});
    await countryCheck({
      'x-6529-edge-auth': EDGE_SECRET,
      'cloudfront-viewer-country': 'FR'
    });
    expect(axios.get).not.toHaveBeenCalled();
  });
});
