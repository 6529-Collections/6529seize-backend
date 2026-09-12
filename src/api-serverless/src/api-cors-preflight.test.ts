import express, { Request, RequestHandler } from 'express';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { corsOptions, getCorsOptionsForRequest } from './api-constants';

const yaml = require('js-yaml') as { load(value: string): unknown };
const cors = require('cors') as (
  options: (
    req: Request,
    callback: (
      error: Error | null,
      options: ReturnType<typeof getCorsOptionsForRequest>
    ) => void
  ) => void
) => RequestHandler;
const IDEMPOTENT_PATHS = [
  '/market/operations',
  '/collect/rules',
  '/collect/rules/{id}/prepare'
];

type ApiOperation = {
  parameters?: { name: string; in: string; required?: boolean }[];
  security?: { bearerAuth: unknown[] }[];
  'x-6529-router'?: { auth?: string };
};

describe('idempotent marketplace and collecting preflights', () => {
  let server: Server;
  let url: string;
  const downstream = jest.fn();

  beforeAll(async () => {
    const app = express();
    // Use the same request-aware CORS middleware as app.ts, before auth/routes.
    app.use(
      cors((req, callback) =>
        callback(
          null,
          getCorsOptionsForRequest(
            req.path,
            req.headers.origin,
            req.headers.host
          )
        )
      )
    );
    app.use((_req, res) => {
      downstream();
      res.sendStatus(401);
    });
    server = await new Promise<Server>((resolveServer) => {
      const listener = app.listen(0, '127.0.0.1', () =>
        resolveServer(listener)
      );
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => downstream.mockClear());

  afterAll(async () => {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    );
  });

  async function preflight(path: string) {
    return fetch(`${url}${path}`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://6529.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers':
          'authorization,content-type,idempotency-key'
      }
    });
  }

  it.each(IDEMPOTENT_PATHS)(
    'permits the browser headers already required by POST %s',
    async (path) => {
      const response = await preflight(
        `/api${path.replace('{id}', 'rule-id')}`
      );
      expect(response.status).toBe(204);
      const allowed = response.headers
        .get('access-control-allow-headers')!
        .toLowerCase()
        .split(',');
      expect(allowed).toEqual([
        ...corsOptions.allowedHeaders.map((header) => header.toLowerCase()),
        'idempotency-key'
      ]);
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(
        response.headers.get('access-control-allow-credentials')
      ).toBeNull();
      expect(response.headers.get('access-control-expose-headers')).toBeNull();
      expect(downstream).not.toHaveBeenCalled();
    }
  );

  it.each([
    '/API/MARKET/operations/',
    '/Api/Collect/rules/',
    '/api/collect/RULES/rule-id/PREPARE/'
  ])(
    'matches normal Express case and trailing-slash routing at %s',
    async (path) => {
      const response = await preflight(path);
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-headers')).toContain(
        'Idempotency-Key'
      );
    }
  );

  it.each([
    '/api/market/orders',
    '/api/market/operations-extra',
    '/api/market/operations/operation-id',
    '/api/market/operations/operation-id/signature',
    '/api/collect/plans',
    '/api/collect/rules/rule-id',
    '/api/collect/rules/rule-id/pause',
    '/api/collect/rules/rule-id/prepare/extra',
    '/api/collect/rules/rule-id/extra/prepare',
    '/api/collect/rules//prepare',
    '/api/drops'
  ])(
    'does not grant an extra request header to adjacent route %s',
    async (path) => {
      const response = await preflight(path);
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-headers')).toBe(
        corsOptions.allowedHeaders.join(',')
      );
    }
  );

  it('covers every documented market/collect idempotent operation without relaxing auth or the required header', () => {
    const spec = yaml.load(
      readFileSync(resolve(__dirname, '../openapi.yaml'), 'utf8')
    ) as { paths: Record<string, Record<string, ApiOperation>> };
    const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(
          ([, operation]) =>
            (path.startsWith('/market/') || path.startsWith('/collect/')) &&
            operation.parameters?.some(
              (parameter) =>
                parameter.in === 'header' &&
                parameter.name === 'Idempotency-Key'
            )
        )
        .map(([method, operation]) => {
          expect(method).toBe('post');
          expect(operation.parameters).toContainEqual(
            expect.objectContaining({
              name: 'Idempotency-Key',
              in: 'header',
              required: true
            })
          );
          expect(operation.security).toEqual([{ bearerAuth: [] }]);
          expect(operation['x-6529-router']?.auth).toBe('required');
          return path;
        })
    );
    const alphabetical = (left: string, right: string) =>
      left.localeCompare(right);
    expect(documented.sort(alphabetical)).toEqual(
      [...IDEMPOTENT_PATHS].sort(alphabetical)
    );
  });

  it('continues past CORS for actual requests, leaving authentication in force', async () => {
    const response = await fetch(`${url}/api/market/operations`, {
      method: 'POST',
      headers: {
        Origin: 'https://6529.io',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'synthetic-idempotency-key'
      },
      body: '{}'
    });
    expect(response.status).toBe(401);
    expect(downstream).toHaveBeenCalledTimes(1);
  });
});
