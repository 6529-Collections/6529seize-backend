import express from 'express';
import { AddressInfo } from 'node:net';
import {
  getTelemetryViewer,
  normalizeViewerCountry,
  parseViewerAddress,
  requireTelemetryEdge
} from '@/api/telemetry/telemetry-edge';

const EDGE_SECRET = 'edge-secret-for-guard-tests';

describe('requireTelemetryEdge', () => {
  let baseUrl = '';
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let reachedRoute = 0;

  beforeAll(async () => {
    const app = express();
    app.use('/api/e', requireTelemetryEdge());
    app.post(['/api/e', '/api/e/diag'], (_req, res) => {
      reachedRoute += 1;
      res.status(204).end();
    });
    app.get('/api/e2ee/me', (_req, res) => {
      res.status(200).end();
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.TELEMETRY_EDGE_SECRET;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    reachedRoute = 0;
    process.env.TELEMETRY_EDGE_SECRET = EDGE_SECRET;
  });

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: '{}' });

  it('rejects /e requests without the edge secret or with a wrong one', async () => {
    expect((await post('/api/e')).status).toBe(403);
    expect((await post('/api/e', { 'x-6529-edge-auth': 'wrong' })).status).toBe(
      403
    );
    expect(
      (
        await post('/api/e/diag', {
          'x-6529-edge-auth': `${EDGE_SECRET}x`,
          'cloudfront-viewer-country': 'US'
        })
      ).status
    ).toBe(403);
    expect(reachedRoute).toBe(0);
  });

  it('hardens every /e response, including rejections', async () => {
    const rejected = await post('/api/e');
    expect(rejected.headers.get('x-content-type-options')).toBe('nosniff');
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    const accepted = await post('/api/e', { 'x-6529-edge-auth': EDGE_SECRET });
    expect(accepted.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('lets edge requests through', async () => {
    expect(
      (await post('/api/e', { 'x-6529-edge-auth': EDGE_SECRET })).status
    ).toBe(204);
    expect(
      (await post('/api/e/diag', { 'x-6529-edge-auth': EDGE_SECRET })).status
    ).toBe(204);
    expect(reachedRoute).toBe(2);
  });

  it('does not guard unrelated routes that only share the prefix', async () => {
    const response = await fetch(`${baseUrl}/api/e2ee/me`);
    expect(response.status).toBe(200);
  });

  it('passes requests through when no secret is configured (local)', async () => {
    delete process.env.TELEMETRY_EDGE_SECRET;
    expect((await post('/api/e')).status).toBe(204);
  });
});

describe('getTelemetryViewer', () => {
  afterEach(() => {
    delete process.env.TELEMETRY_EDGE_SECRET;
  });

  const request = (headers: Record<string, string>) =>
    ({ headers, socket: { remoteAddress: '198.51.100.8' } }) as any;

  it('trusts viewer headers only with the edge secret', () => {
    process.env.TELEMETRY_EDGE_SECRET = EDGE_SECRET;
    const headers = {
      'cloudfront-viewer-address': '203.0.113.9:4431',
      'cloudfront-viewer-country': 'fr'
    };
    expect(
      getTelemetryViewer(
        request({ ...headers, 'x-6529-edge-auth': EDGE_SECRET })
      )
    ).toEqual({ ip: '203.0.113.9', country: 'FR', viaEdge: true });
    expect(getTelemetryViewer(request(headers))).toEqual({
      ip: '198.51.100.8',
      country: '',
      viaEdge: false
    });
  });

  it('parses viewer addresses and countries', () => {
    expect(parseViewerAddress('203.0.113.9:443')).toBe('203.0.113.9');
    expect(parseViewerAddress('2001:db8::1:51000')).toBe('2001:db8::1');
    expect(parseViewerAddress('not-an-ip:1')).toBe('');
    expect(parseViewerAddress('')).toBe('');
    expect(normalizeViewerCountry('us')).toBe('US');
    expect(normalizeViewerCountry('XX')).toBe('');
    expect(normalizeViewerCountry('USA')).toBe('');
  });
});
