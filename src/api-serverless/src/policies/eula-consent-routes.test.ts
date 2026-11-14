import 'reflect-metadata';
// Preserve Passport's real prototype methods through ts-jest's namespace
// interop; authentication and JWT verification still run normally.
jest.mock('passport', () => {
  const actual = jest.requireActual<typeof import('passport')>('passport');
  return {
    __esModule: true,
    default: actual,
    authenticate: actual.authenticate.bind(actual),
    initialize: actual.initialize.bind(actual),
    use: actual.use.bind(actual)
  };
});
jest.mock('./policies.db', () => ({
  deleteOwnedEULAConsent: jest.fn(),
  fetchEULAConsent: jest.fn(),
  saveEULAConsent: jest.fn()
}));

import express, { ErrorRequestHandler } from 'express';
import * as passport from 'passport';
import { Strategy as AnonymousStrategy } from 'passport-anonymous';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';
import * as mcache from 'memory-cache';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';
import { profileProxyApiService } from '@/api/proxies/proxy.api.service';
import { ApiCompliantException } from '@/exceptions';
import { identitiesDb } from '@/identities/identities.db';
import { CURRENT_EULA_VERSION } from './eula-policy';
import { deleteOwnedEULAConsent, saveEULAConsent } from './policies.db';

const secret = 'disposable-eula-route-test-signing-key';
const OWNER_WALLET = '0x0000000000000000000000000000000000000001';
const NO_PROFILE_WALLET = '0x0000000000000000000000000000000000000002';
const PROFILE_BY_WALLET: Record<string, string> = {
  [OWNER_WALLET]: 'profile-1'
};

describe('/policies/eula-consent', () => {
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    mcache.clear();
    jest
      .mocked(deleteOwnedEULAConsent)
      .mockReset()
      .mockResolvedValue(undefined);
    jest.mocked(saveEULAConsent).mockReset().mockResolvedValue(undefined);
    jest
      .spyOn(identitiesDb, 'getProfileIdByWallet')
      .mockImplementation(async (wallet) => PROFILE_BY_WALLET[wallet] ?? null);
    jest
      .spyOn(profileProxyApiService, 'getProxyByGrantedByAndGrantedTo')
      .mockResolvedValue(null);
    passport.use(
      new JwtStrategy(
        {
          jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
          secretOrKey: secret,
          algorithms: ['HS256']
        },
        (payload, done) =>
          done(null, { wallet: payload.sub, role: payload.role ?? null })
      )
    );
    passport.use(new AnonymousStrategy());
    const app = express();
    app.use(express.json());
    app.use(passport.initialize());
    app.use(generatedOpenApiRoutes);
    const errors: ErrorRequestHandler = (error, _req, res, _next) =>
      res
        .status(
          error instanceof ApiCompliantException ? error.getStatusCode() : 500
        )
        .json({ error: error.message });
    app.use(errors);
    server = await new Promise<Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  function send(method: 'POST' | 'DELETE', body: unknown, token?: string) {
    return fetch(`${origin}/policies/eula-consent`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
  }

  const deleteConsent = (body: unknown, token?: string) =>
    send('DELETE', body, token);

  const saveConsent = (token?: string) =>
    send(
      'POST',
      {
        device_id: 'device-1',
        platform: 'ios',
        eula_version: CURRENT_EULA_VERSION
      },
      token
    );

  const tokenFor = (wallet: string, role?: string) =>
    jwt.sign({ sub: wallet, ...(role ? { role } : {}) }, secret, {
      algorithm: 'HS256',
      expiresIn: 60
    });

  const validToken = () => tokenFor(OWNER_WALLET);
  const proxyToken = () => tokenFor(OWNER_WALLET, 'granting-profile');
  const foreignKeyToken = () =>
    jwt.sign({ sub: OWNER_WALLET }, 'another-key', {
      algorithm: 'HS256',
      expiresIn: 60
    });

  describe('DELETE', () => {
    it('answers 401 without a token and deletes nothing', async () => {
      const response = await deleteConsent({ device_id: 'device-1' });

      expect(response.status).toBe(401);
      expect(deleteOwnedEULAConsent).not.toHaveBeenCalled();
    });

    it('answers 401 for a token signed with another key', async () => {
      const response = await deleteConsent(
        { device_id: 'device-1' },
        foreignKeyToken()
      );

      expect(response.status).toBe(401);
      expect(deleteOwnedEULAConsent).not.toHaveBeenCalled();
    });

    it('deletes only consent owned by the caller', async () => {
      const response = await deleteConsent(
        { device_id: ' device-1 ' },
        validToken()
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        message: 'EULA consent deleted'
      });
      expect(deleteOwnedEULAConsent).toHaveBeenCalledTimes(1);
      expect(deleteOwnedEULAConsent).toHaveBeenCalledWith(
        'device-1',
        'profile-1'
      );
    });

    it.each([
      ['a wallet without a profile', () => tokenFor(NO_PROFILE_WALLET)],
      ['a proxy token', proxyToken]
    ])('answers the same 200 for %s and deletes nothing', async (_, token) => {
      const response = await deleteConsent({ device_id: 'device-1' }, token());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        message: 'EULA consent deleted'
      });
      expect(deleteOwnedEULAConsent).not.toHaveBeenCalled();
    });

    it.each([{ device_id: 'device 1' }, { device_id: '' }, {}])(
      'answers 400 for the invalid body %p and deletes nothing',
      async (body) => {
        const response = await deleteConsent(body, validToken());

        expect(response.status).toBe(400);
        expect(deleteOwnedEULAConsent).not.toHaveBeenCalled();
      }
    );
  });

  describe('POST', () => {
    it.each([
      ['without a token', () => undefined, null],
      ['with a valid token', validToken, 'profile-1'],
      ['with a token signed with another key', foreignKeyToken, null],
      ['with a proxy token', proxyToken, null],
      [
        'for a wallet without a profile',
        () => tokenFor(NO_PROFILE_WALLET),
        null
      ]
    ])('saves consent %s with the resolved owner', async (_, token, owner) => {
      const response = await saveConsent(token());

      expect(response.status).toBe(200);
      expect(saveEULAConsent).toHaveBeenCalledWith(
        'device-1',
        'ios',
        CURRENT_EULA_VERSION,
        owner
      );
    });
  });
});
