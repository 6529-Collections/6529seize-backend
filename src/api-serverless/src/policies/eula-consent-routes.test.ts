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
  deleteEULAConsent: jest.fn(),
  fetchEULAConsent: jest.fn(),
  saveEULAConsent: jest.fn()
}));

import express, { ErrorRequestHandler } from 'express';
import * as passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import generatedOpenApiRoutes from '@/api/generated/routes/openapi-generated.routes';
import { ApiCompliantException } from '@/exceptions';
import { deleteEULAConsent } from './policies.db';

const secret = 'disposable-eula-route-test-signing-key';

describe('DELETE /policies/eula-consent', () => {
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    jest.mocked(deleteEULAConsent).mockReset().mockResolvedValue(undefined);
    passport.use(
      new JwtStrategy(
        {
          jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
          secretOrKey: secret,
          algorithms: ['HS256']
        },
        (payload, done) => done(null, { wallet: payload.sub, role: null })
      )
    );
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  function deleteConsent(body: unknown, token?: string) {
    return fetch(`${origin}/policies/eula-consent`, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    });
  }

  const validToken = () =>
    jwt.sign({ sub: '0x0000000000000000000000000000000000000001' }, secret, {
      algorithm: 'HS256',
      expiresIn: 60
    });

  it('answers 401 without a token and deletes nothing', async () => {
    const response = await deleteConsent({ device_id: 'device-1' });

    expect(response.status).toBe(401);
    expect(deleteEULAConsent).not.toHaveBeenCalled();
  });

  it('answers 401 for a token signed with another key', async () => {
    const token = jwt.sign({ sub: '0x01' }, 'another-key', {
      algorithm: 'HS256',
      expiresIn: 60
    });

    const response = await deleteConsent({ device_id: 'device-1' }, token);

    expect(response.status).toBe(401);
    expect(deleteEULAConsent).not.toHaveBeenCalled();
  });

  it('deletes the consent for a valid token and body', async () => {
    const response = await deleteConsent(
      { device_id: ' device-1 ' },
      validToken()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      message: 'EULA consent deleted'
    });
    expect(deleteEULAConsent).toHaveBeenCalledTimes(1);
    expect(deleteEULAConsent).toHaveBeenCalledWith('device-1');
  });

  it.each([{ device_id: 'device 1' }, { device_id: '' }, {}])(
    'answers 400 for the invalid body %p and deletes nothing',
    async (body) => {
      const response = await deleteConsent(body, validToken());

      expect(response.status).toBe(400);
      expect(deleteEULAConsent).not.toHaveBeenCalled();
    }
  );
});
