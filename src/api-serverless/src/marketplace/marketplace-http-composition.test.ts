import express, { ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { marketErrorMiddleware } from './marketplace.http';
import { documentationErrorMiddleware } from '@/api/artwork-documentation/artwork-documentation.http';
import {
  cmsAgentErrorMiddleware,
  cmsAgentPrivateHeadersMiddleware
} from '@/api/profile-cms/profile-cms-agent.http';
import type { ApiCompliantException } from '@/exceptions';

describe('composed private API error middleware', () => {
  let server: Server;
  let url: string;
  const marker = 'synthetic-private-request';
  beforeAll(async () => {
    const app = express();
    app.use(cmsAgentPrivateHeadersMiddleware);
    app.use(express.json());
    app.post(
      ['/api/market/operations/id/signature', '/api/collect/rules'],
      (_req, res) => res.sendStatus(200)
    );
    // Match the application order before the error telemetry integration.
    app.use(documentationErrorMiddleware);
    app.use(marketErrorMiddleware);
    app.use(cmsAgentErrorMiddleware);
    const capture: ErrorRequestHandler = (
      error: ApiCompliantException,
      req,
      res,
      _next
    ) => {
      res.status(error.getStatusCode()).json({
        code: error.code,
        inputRetained:
          JSON.stringify(error).includes(marker) ||
          error.message.includes(marker),
        requestBodyRetained: req.body !== undefined,
        queryRetained: Object.keys(req.query).length > 0
      });
    };
    app.use(capture);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it('keeps ordinary Express case-insensitive marketplace routing', async () => {
    const response = await fetch(`${url}/API/MARKET/operations/id/signature`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ['/api/market/operations/id/signature', 'INVALID_JSON'],
    ['/API/MARKET/operations/id/signature', 'INVALID_JSON'],
    ['/Api/Market/operations/id/signature', 'INVALID_JSON'],
    ['/API/COLLECT/rules', 'INVALID_JSON'],
    ['/Api/Collect/rules', 'INVALID_JSON'],
    ['/API/PROFILE-CMS/agent-session/proposals', 'cms_agent_invalid_json'],
    ['/api/artwork-documentation/documents', 'INVALID_JSON']
  ])('sanitizes malformed JSON at %s before telemetry', async (path, code) => {
    const response = await fetch(`${url}${path}?signature=${marker}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"signature":"${marker}`
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code,
      inputRetained: false,
      requestBodyRetained: false,
      queryRetained: false
    });
    if (path !== '/api/artwork-documentation/documents')
      expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});
