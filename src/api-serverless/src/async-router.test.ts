import express, { ErrorRequestHandler } from 'express';
import { Server } from 'node:http';
import { CustomApiCompliantException } from '@/exceptions';
import { documentationErrorMiddleware } from '@/api/artwork-documentation/artwork-documentation.http';
import { asyncRouter } from './async.router';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn().mockResolvedValue({})
}));
jest.mock('@/artwork-documentation/artwork-documentation.service', () => ({
  artworkDocumentationService: {}
}));
jest.mock('@/artwork-documentation/artwork-documentation.review', () => ({
  artworkDocumentationReviewService: {}
}));
jest.mock('@/artwork-documentation/assets/artwork-assets.service', () => ({
  artworkAssetsService: {}
}));
jest.mock(
  '@/artwork-documentation/artwork-documentation.asset-links',
  () => ({})
);

import { executeDocumentationRequest } from '@/api/artwork-documentation/artwork-documentation.handlers';

async function withServer(
  method: 'get' | 'post' | 'patch',
  status: number,
  code: string,
  run: (url: string, captured: unknown[]) => Promise<void>
) {
  const app = express();
  const router = asyncRouter();
  const captured: unknown[] = [];
  app.use(express.json());
  router[method]('/response', async (req, res) => {
    res.json(
      await executeDocumentationRequest(req, async () => {
        await Promise.resolve();
        if (status !== 200)
          throw new CustomApiCompliantException(
            status,
            `artworkDocumentation.errors.${code}`,
            code
          );
        return { draft_version: 2 };
      })
    );
  });
  app.use('/api/artwork-documentation', router);
  app.use(documentationErrorMiddleware);
  const respond: ErrorRequestHandler = (
    error: CustomApiCompliantException,
    req,
    res,
    _next
  ) => {
    captured.push({ code: error.code, body: req.body, query: req.query });
    res.status(error.getStatusCode()).json({ code: error.code });
  };
  app.use(respond);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP listener');
    await run(
      `http://127.0.0.1:${address.port}/api/artwork-documentation/response`,
      captured
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('async router HTTP error forwarding', () => {
  it.each([
    ['patch', 409, 'IDEMPOTENCY_MISMATCH'],
    ['patch', 422, 'INVALID_REQUEST'],
    ['patch', 404, 'UNAVAILABLE'],
    ['get', 404, 'UNAVAILABLE'],
    ['post', 422, 'REQUIRED_ANSWERS_MISSING']
  ] as const)(
    'forwards a rejected %s handler as HTTP %s',
    async (method, status, code) => {
      await withServer(method, status, code, async (url, captured) => {
        const response = await fetch(url, {
          method: method.toUpperCase(),
          ...(method !== 'get'
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ private_answer: 'private-marker' })
              }
            : {}),
          signal: AbortSignal.timeout(3000)
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ code });
        expect(captured).toEqual([{ code, body: undefined, query: {} }]);
      });
    }
  );

  it('preserves a successful PATCH response', async () => {
    await withServer('patch', 200, '', async (url, captured) => {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'synthetic' }),
        signal: AbortSignal.timeout(3000)
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ draft_version: 2 });
      expect(captured).toEqual([]);
    });
  });
});
