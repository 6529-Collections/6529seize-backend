import express from 'express';
import { AddressInfo } from 'node:net';
import * as http from 'node:http';
import {
  FROZEN_PROXY_ACTION_TYPES,
  identityFreezeMiddleware,
  isFrozenIdentityWrite
} from '@/api/identity-freeze/identity-freeze.middleware';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import {
  IDENTITY_FROZEN_CODE,
  IDENTITY_FROZEN_MESSAGE
} from '@/identity-freeze/identity-freeze';
import { ApiProfileProxyActionType } from '@/api/generated/models/ApiProfileProxyActionType';

const FLAG = 'FEATURE_IDENTITY_FROZEN';

describe('isFrozenIdentityWrite', () => {
  it.each([
    ['POST', '/profiles'],
    ['POST', '/profiles/'],
    ['POST', '/profiles/pfp/ipfs'],
    ['POST', '/profiles/someone/pfp'],
    ['POST', '/profiles/someone/wave'],
    ['DELETE', '/profiles/someone/wave'],
    ['POST', '/profiles/someone/cic/rating'],
    ['POST', '/profiles/someone/cic/statements'],
    ['DELETE', '/profiles/someone/cic/statements/statement-1'],
    ['POST', '/profiles/someone/rep/rating'],
    ['POST', '/Profiles/someone/rep/rating'],
    ['PUT', '/profiles/someone'],
    ['PATCH', '/profiles/someone'],
    ['POST', '/ratings'],
    ['POST', '/ratings/'],
    ['POST', '/bulk-rep'],
    ['post', '/bulk-rep']
  ])('refuses %s %s', (method, path) => {
    expect(isFrozenIdentityWrite({ method, path })).toBe(true);
  });

  it.each([
    ['GET', '/profiles/someone'],
    ['HEAD', '/profiles/someone'],
    ['OPTIONS', '/profiles'],
    ['GET', '/ratings/credit'],
    ['POST', '/profiles-but-not-really'],
    ['POST', '/drops'],
    ['POST', '/waves/wave-1/rep'],
    ['POST', '/proxies'],
    ['POST', '/proxies/proxy-1/actions/action-1/acceptance'],
    ['PUT', '/proxies/proxy-1/actions/action-1'],
    ['POST', '/identities/someone/mute'],
    ['POST', '/auth/login']
  ])('lets %s %s through', (method, path) => {
    expect(isFrozenIdentityWrite({ method, path })).toBe(false);
  });

  it.each(Object.values(ApiProfileProxyActionType))(
    'decides a new %s proxy action by its type',
    (actionType) => {
      expect(
        isFrozenIdentityWrite({
          method: 'POST',
          path: '/proxies/proxy-1/actions',
          body: { action_type: actionType }
        })
      ).toBe(FROZEN_PROXY_ACTION_TYPES.has(actionType));
    }
  );

  it('freezes exactly the REP and NIC allocations', () => {
    expect(
      Array.from(FROZEN_PROXY_ACTION_TYPES).sort((a, b) => a.localeCompare(b))
    ).toEqual(
      [
        ApiProfileProxyActionType.AllocateCic,
        ApiProfileProxyActionType.AllocateRep
      ].sort((a, b) => a.localeCompare(b))
    );
  });

  it('lets a proxy action with no readable type reach its validation', () => {
    for (const body of [undefined, null, {}, { action_type: 7 }, 'text']) {
      expect(
        isFrozenIdentityWrite({
          method: 'POST',
          path: '/proxies/proxy-1/actions',
          body
        })
      ).toBe(false);
    }
  });
});

describe('identityFreezeMiddleware', () => {
  const original = process.env[FLAG];
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const apiRouter = express.Router();
    apiRouter.use(identityFreezeMiddleware());
    const reached = (_req: express.Request, res: express.Response) => {
      res.status(200).send({ reached: true });
    };
    apiRouter.post('/profiles', reached);
    apiRouter.get('/profiles/:identity', reached);
    apiRouter.post('/profiles/:identity/rep/rating', reached);
    apiRouter.post('/proxies/:proxyId/actions', reached);
    apiRouter.post('/drops', reached);
    app.use('/api', apiRouter);
    app.use(customErrorMiddleware());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  function call(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload)
              }
            : {}
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: data ? JSON.parse(data) : null
            })
          );
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('refuses identity writes with 423 and the freeze code when on', async () => {
    process.env[FLAG] = 'true';
    for (const path of ['/api/profiles', '/api/profiles/someone/rep/rating']) {
      const response = await call('POST', path, { handle: 'someone' });
      expect(response.status).toBe(423);
      expect(response.body).toEqual({
        error: IDENTITY_FROZEN_MESSAGE,
        code: IDENTITY_FROZEN_CODE
      });
    }
    const allocation = await call('POST', '/api/proxies/proxy-1/actions', {
      action_type: 'ALLOCATE_REP',
      credit_amount: 10
    });
    expect(allocation.status).toBe(423);
  });

  it('keeps reads, drops and wave proxy actions working when on', async () => {
    process.env[FLAG] = 'true';
    expect((await call('GET', '/api/profiles/someone')).status).toBe(200);
    expect((await call('POST', '/api/drops', {})).status).toBe(200);
    expect(
      (
        await call('POST', '/api/proxies/proxy-1/actions', {
          action_type: 'CREATE_DROP_TO_WAVE'
        })
      ).status
    ).toBe(200);
  });

  it.each([undefined, 'false', 'TRUE', '1', ''])(
    'changes nothing when the flag is %s',
    async (value) => {
      if (value === undefined) delete process.env[FLAG];
      else process.env[FLAG] = value;
      expect((await call('POST', '/api/profiles', {})).status).toBe(200);
      expect(
        (await call('POST', '/api/profiles/someone/rep/rating', {})).status
      ).toBe(200);
    }
  );
});
