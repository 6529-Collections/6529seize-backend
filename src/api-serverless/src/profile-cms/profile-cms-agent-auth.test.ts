import express, { NextFunction, Request, Response } from 'express';
import * as passport from 'passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { sign } from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { ApiCompliantException } from '@/exceptions';
import {
  cmsAgentPrivateHeadersMiddleware,
  cmsAgentErrorMiddleware,
  validateCmsAgentRawBody
} from './profile-cms-agent.http';

jest.mock('passport', () => {
  const actual = jest.requireActual<typeof import('passport')>('passport');
  // Preserve inherited Passport methods through ts-jest's namespace interop.
  Object.defineProperty(actual, '__esModule', { value: true });
  return actual;
});

jest.mock('@/api/identities/identity.fetcher', () => ({ identityFetcher: {} }));
jest.mock('@/api/proxies/proxy.api.service', () => ({
  profileProxyApiService: {},
  isProxyActionActive: jest.fn()
}));
import { needsAuthenticatedUser } from '@/api/auth/auth';

describe('CMS capabilities cannot authenticate as wallets', () => {
  let server: Server;
  let url: string;
  let walletToken: string;
  const reached = jest.fn();
  beforeAll(async () => {
    const secret = randomBytes(32).toString('hex');
    walletToken = sign({ sub: `0x${'1'.repeat(40)}` }, secret, {
      expiresIn: 60
    });
    passport.use(
      'jwt',
      new Strategy(
        {
          secretOrKey: secret,
          jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken()
        },
        (payload, done) => done(null, { wallet: payload.sub, role: null })
      )
    );
    const app = express();
    app.use(cmsAgentPrivateHeadersMiddleware);
    app.use(passport.initialize());
    app.use(
      express.json({
        limit: '5mb',
        verify: (req, _res, bytes) =>
          validateCmsAgentRawBody(req.url ?? '', bytes.length)
      })
    );
    app.post(
      [
        '/api/profile-cms/packages',
        '/api/profile-cms/packages/id/publish',
        '/api/profile-cms/packages/id/storage/upload',
        '/api/profile-cms/packages/id/agent-grants'
      ],
      needsAuthenticatedUser(),
      (_req, res) => {
        reached();
        res.sendStatus(200);
      }
    );
    app.use(cmsAgentErrorMiddleware);
    app.use(
      (
        error: ApiCompliantException,
        _req: Request,
        res: Response,
        _next: NextFunction
      ) => {
        res.status(error.getStatusCode()).send({ code: error.code });
      }
    );
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    passport.unuse('jwt');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });
  beforeEach(() => reached.mockClear());

  it('confirms ordinary wallet authentication still works', async () => {
    const result = await fetch(`${url}/api/profile-cms/packages/id/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${walletToken}` }
    });
    expect(result.status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });
  it.each([
    '/api/profile-cms/packages',
    '/api/profile-cms/packages/id/publish',
    '/api/profile-cms/packages/id/storage/upload',
    '/api/profile-cms/packages/id/agent-grants'
  ])('rejects a scoped token at %s before its handler', async (path) => {
    const result = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer cms_agent_00000000-0000-4000-8000-000000000000.${'a'.repeat(64)}`
      }
    });
    expect(result.status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
    if (path.endsWith('agent-grants'))
      expect(result.headers.get('cache-control')).toBe('private, no-store');
  });
  it.each([
    '/api/profile-cms/packages/id/agent-grants',
    '/API/PROFILE-CMS/PACKAGES/id/AGENT-GRANTS?ignored=value'
  ])('keeps no-store before authentication and parsing at %s', async (path) => {
    const anonymous = await fetch(`${url}${path}`, { method: 'POST' });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    const malformed = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"private":"unclosed'
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('cache-control')).toBe('private, no-store');
    expect(await malformed.json()).toEqual({ code: 'cms_agent_invalid_json' });
  });
});
