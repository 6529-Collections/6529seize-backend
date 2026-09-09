import express, { ErrorRequestHandler } from 'express';
import { Server } from 'node:http';
import * as Joi from 'joi';
import { ApiCompliantException } from '@/exceptions';
import { validateDocumentationRawJson } from '@/artwork-documentation/artwork-documentation.raw-json';
import {
  documentationErrorMiddleware,
  sanitizeDocumentationError,
  validateDocumentationBody
} from './artwork-documentation.http';

async function withServer(
  run: (url: string, errors: unknown[]) => Promise<void>
) {
  const app = express();
  const errors: unknown[] = [];
  app.use(
    express.json({
      limit: '5mb',
      verify: (_req, _res, bytes) => validateDocumentationRawJson(bytes)
    })
  );
  app.post('/api/artwork-documentation/works', (req, res) => {
    res.json(
      validateDocumentationBody(
        req.body,
        Joi.object({ title: Joi.string().required() })
      )
    );
  });
  app.use(documentationErrorMiddleware);
  const respond: ErrorRequestHandler = (
    error: ApiCompliantException,
    req,
    res,
    _next
  ) => {
    errors.push({ error, body: req.body, query: req.query });
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
      `http://127.0.0.1:${address.port}/api/artwork-documentation/works`,
      errors
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

describe('private documentation HTTP validation', () => {
  it.each([
    ['malformed JSON', '{"title":"private-marker",', 400, 'INVALID_JSON'],
    [
      'documentation limit',
      JSON.stringify({ title: 'x'.repeat(524288) }),
      413,
      'WRITE_REQUEST_LIMIT'
    ],
    [
      'parser limit',
      JSON.stringify({ title: 'x'.repeat(5 * 1024 * 1024) }),
      413,
      'WRITE_REQUEST_LIMIT'
    ],
    [
      'duplicate fields',
      '{"title":"private-marker","title":"duplicate"}',
      422,
      'DUPLICATE_JSON_KEY'
    ]
  ])(
    'preserves the safe response for %s',
    async (_label, payload, status, code) => {
      await withServer(async (url, errors) => {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload as string
        });
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ code });
        expect(JSON.stringify(errors)).not.toContain('private-marker');
        expect(JSON.stringify(errors)).not.toContain('xxxxx');
        expect(errors).toHaveLength(1);
      });
    }
  );
  it('returns INVALID_REQUEST when a mutation has no body', async () => {
    await withServer(async (url) => {
      const response = await fetch(url, { method: 'POST' });
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ code: 'INVALID_REQUEST' });
    });
    expect(() => validateDocumentationBody(undefined, Joi.object())).toThrow(
      expect.objectContaining({ code: 'INVALID_REQUEST' })
    );
  });
  it('reserves status 500 for non-parser failures and drops attached input', () => {
    const failure = Object.assign(new Error('private-marker'), {
      status: 400,
      body: 'private-marker'
    });
    const safe = sanitizeDocumentationError(failure);
    expect(safe.getStatusCode()).toBe(500);
    expect(safe.code).toBe('DOCUMENTATION_OPERATION_FAILED');
    expect(JSON.stringify(safe)).not.toContain('private-marker');
  });
});
