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
const MODERATED_SUBMISSION_PATHS = [
  '/drops',
  '/drops/{id}',
  '/profiles/{id}/cic/statements',
  '/groups/{id}/visible'
];

type ApiOperation = {
  parameters?: { name: string; in: string; required?: boolean }[];
  security?: { bearerAuth: unknown[] }[];
  'x-6529-router'?: { auth?: string };
};

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
        getCorsOptionsForRequest(req.path, req.headers.origin, req.headers.host)
      )
    )
  );
  app.get(
    ['/api/identities/retry-profile', '/api/e2ee/devices/retry-device'],
    (_req, res) => res.set('Retry-After', '17').sendStatus(429)
  );
  app.use((_req, res) => {
    downstream();
    res.sendStatus(401);
  });
  server = await new Promise<Server>((resolveServer) => {
    const listener = app.listen(0, '127.0.0.1', () => resolveServer(listener));
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => downstream.mockClear());

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose()))
  );
});

describe('identity lookup retry headers', () => {
  it.each(['/api/identities/retry-profile', '/api/e2ee/devices/retry-device'])(
    'exposes the server cooldown on a rate-limited GET %s',
    async (path) => {
      const response = await fetch(`${url}${path}`, {
        headers: { Origin: 'https://6529.io' }
      });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('17');
      expect(response.headers.get('access-control-expose-headers')).toBe(
        'X-Request-Id,Retry-After'
      );
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(
        response.headers.get('access-control-allow-credentials')
      ).toBeNull();
    }
  );
});

describe('idempotent API submission preflights', () => {
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

  it.each([...IDEMPOTENT_PATHS, ...MODERATED_SUBMISSION_PATHS])(
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
      // Public routes expose only the request id (C52 request ids), never
      // the credentialed auth headers.
      expect(response.headers.get('access-control-expose-headers')).toBe(
        'X-Request-Id'
      );
      expect(downstream).not.toHaveBeenCalled();
    }
  );

  it.each([
    '/API/MARKET/operations/',
    '/Api/Collect/rules/',
    '/api/collect/RULES/rule-id/PREPARE/',
    '/API/DROPS/',
    '/Api/Drops/drop-id/',
    '/api/Profiles/profile-id/CIC/Statements/',
    '/api/Groups/group-id/Visible/'
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
    '/api/drops-extra',
    '/api/drops/drop-id/reaction',
    '/api/profiles/profile-id/cic/statements/extra',
    '/api/profiles/profile-id/cic',
    '/api/groups/group-id/visible/extra',
    '/api/groups//visible'
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

  it.each(['/market/operations', ...MODERATED_SUBMISSION_PATHS])(
    'continues past CORS for POST %s, leaving authentication in force',
    async (path) => {
      const response = await fetch(
        `${url}/api${path.replace('{id}', 'test-id')}`,
        {
          method: 'POST',
          headers: {
            Origin: 'https://6529.io',
            'Content-Type': 'application/json',
            'Idempotency-Key': 'synthetic-idempotency-key'
          },
          body: '{}'
        }
      );
      expect(response.status).toBe(401);
      expect(downstream).toHaveBeenCalledTimes(1);
    }
  );
});

describe('preflight cache lifetime', () => {
  // The test server listens on 127.0.0.1, so local web origins stand in for
  // the production web origin on the credentialed variants.
  const LOCAL_WEB_ORIGIN = 'http://localhost:3001';

  it.each([
    {
      variant: 'default authenticated read',
      path: '/api/v2/notifications?include_competitions=true&limit=1',
      origin: 'https://6529.io',
      method: 'GET',
      headers: 'authorization',
      allowOrigin: '*',
      allowCredentials: null
    },
    {
      variant: 'idempotent submission',
      path: '/api/market/operations',
      origin: 'https://6529.io',
      method: 'POST',
      headers: 'authorization,content-type,idempotency-key',
      allowOrigin: '*',
      allowCredentials: null
    },
    {
      variant: 'credentialed web auth',
      path: '/api/auth/session-refresh',
      origin: LOCAL_WEB_ORIGIN,
      method: 'POST',
      headers: 'content-type',
      allowOrigin: LOCAL_WEB_ORIGIN,
      allowCredentials: 'true'
    },
    {
      variant: 'artwork documentation',
      path: '/api/artwork-documentation/works',
      origin: LOCAL_WEB_ORIGIN,
      method: 'PUT',
      headers: 'authorization,content-type,if-match,idempotency-key',
      allowOrigin: LOCAL_WEB_ORIGIN,
      allowCredentials: null
    }
  ])(
    'lets browsers cache the $variant preflight for two hours',
    async ({
      path,
      origin,
      method,
      headers,
      allowOrigin,
      allowCredentials
    }) => {
      const response = await fetch(`${url}${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': headers
        }
      });
      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-max-age')).toBe('7200');
      expect(response.headers.get('access-control-allow-origin')).toBe(
        allowOrigin
      );
      expect(response.headers.get('access-control-allow-credentials')).toBe(
        allowCredentials
      );
      expect(downstream).not.toHaveBeenCalled();
    }
  );

  it('grants no cacheable preflight to an untrusted origin on a credentialed route', async () => {
    const response = await fetch(`${url}/api/auth/session-refresh`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type'
      }
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-max-age')).toBeNull();
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  it('leaves simple GET responses without a preflight cache header', async () => {
    const response = await fetch(`${url}/api/v2/notifications?limit=1`, {
      headers: { Origin: 'https://6529.io' }
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-expose-headers')).toBe(
      'X-Request-Id'
    );
    expect(response.headers.get('access-control-max-age')).toBeNull();
    expect(downstream).toHaveBeenCalledTimes(1);
  });
});
