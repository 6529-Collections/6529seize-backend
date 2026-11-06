import express from 'express';
import { AddressInfo } from 'node:net';
import telemetryCountryRoutes, {
  getTelemetryCountry
} from '@/api/telemetry/telemetry-country.routes';

const EDGE_SECRET = 'edge-secret-for-country-tests';

function request(headers: Record<string, string>) {
  return { headers, socket: { remoteAddress: '198.51.100.4' } } as any;
}

describe('getTelemetryCountry', () => {
  beforeEach(() => {
    process.env.TELEMETRY_EDGE_SECRET = EDGE_SECRET;
  });

  afterAll(() => {
    delete process.env.TELEMETRY_EDGE_SECRET;
  });

  it('answers from the trusted CloudFront viewer country', () => {
    expect(
      getTelemetryCountry(
        request({
          'x-6529-edge-auth': EDGE_SECRET,
          'cloudfront-viewer-country': 'US'
        })
      )
    ).toEqual({ country: 'US', is_eu: false });
    expect(
      getTelemetryCountry(
        request({
          'x-6529-edge-auth': EDGE_SECRET,
          'cloudfront-viewer-country': 'DE'
        })
      )
    ).toEqual({ country: 'DE', is_eu: true });
  });

  it('fails closed when the country is unknown or untrusted', () => {
    const unknown = { country: null, is_eu: true };
    // Direct API call claiming to be US: ignored.
    expect(
      getTelemetryCountry(request({ 'cloudfront-viewer-country': 'US' }))
    ).toEqual(unknown);
    expect(
      getTelemetryCountry(
        request({
          'x-6529-edge-auth': 'wrong',
          'cloudfront-viewer-country': 'US'
        })
      )
    ).toEqual(unknown);
    // CloudFront could not tell.
    expect(
      getTelemetryCountry(
        request({
          'x-6529-edge-auth': EDGE_SECRET,
          'cloudfront-viewer-country': 'XX'
        })
      )
    ).toEqual(unknown);
    expect(
      getTelemetryCountry(request({ 'x-6529-edge-auth': EDGE_SECRET }))
    ).toEqual(unknown);
    // No edge secret configured: nothing is trusted.
    delete process.env.TELEMETRY_EDGE_SECRET;
    expect(
      getTelemetryCountry(
        request({ 'x-6529-edge-auth': '', 'cloudfront-viewer-country': 'US' })
      )
    ).toEqual(unknown);
  });
});

describe('GET /api/e/country', () => {
  it('is never cached', async () => {
    const app = express();
    app.use('/api/e/country', telemetryCountryRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/api/e/country`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({ country: null, is_eu: true });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
