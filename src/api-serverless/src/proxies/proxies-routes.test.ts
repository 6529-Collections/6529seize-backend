import express, { ErrorRequestHandler } from 'express';
import { request, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ApiCompliantException } from '@/exceptions';
import { profileProxyApiService } from './proxy.api.service';
import router from './proxies.routes';

jest.mock('passport', () => ({
  authenticate: jest.fn(
    () => (_req: unknown, _res: unknown, next: () => void) => next()
  )
}));
jest.mock('../auth/auth', () => ({
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getWalletOrThrow: () => '0xgrantor'
}));
jest.mock('../identities/identity.fetcher', () => ({
  identityFetcher: {
    getProfileIdByIdentityKey: jest.fn().mockResolvedValue('grantor')
  }
}));
jest.mock('./proxy.api.service', () => ({
  profileProxyApiService: {
    getProfileProxyByIdOrThrow: jest.fn().mockResolvedValue({
      id: 'proxy-1',
      created_by: { id: 'grantor' },
      granted_to: { id: 'grantee' },
      actions: []
    }),
    createProfileProxyAction: jest.fn(),
    updateProfileProxyAction: jest.fn()
  }
}));

const createAction = jest.mocked(
  profileProxyApiService.createProfileProxyAction
);
const updateAction = jest.mocked(
  profileProxyApiService.updateProfileProxyAction
);

describe('proxy action routes wave_allowlist validation', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/proxies', router);
    const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
      const status =
        error instanceof ApiCompliantException ? error.getStatusCode() : 500;
      res
        .status(status)
        .json({ message: error instanceof Error ? error.message : 'Error' });
    };
    app.use(errors);
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    createAction.mockReset();
    createAction.mockResolvedValue({ id: 'action-1' } as never);
    updateAction.mockReset();
    updateAction.mockResolvedValue({ id: 'action-1' } as never);
  });

  function send(
    method: 'POST' | 'PUT',
    path: string,
    body: unknown
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = request(
        `${baseUrl}${path}`,
        { method, headers: { 'Content-Type': 'application/json' } },
        (response) => {
          response.setEncoding('utf8');
          let text = '';
          response.on('data', (chunk: string) => (text += chunk));
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 500,
              json: text ? JSON.parse(text) : null
            })
          );
        }
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }

  describe('POST /proxies/:proxy_id/actions', () => {
    const create = (body: unknown) =>
      send('POST', '/proxies/proxy-1/actions', body);

    it('accepts a scoped CREATE_DROP_TO_WAVE grant and passes the list through', async () => {
      const res = await create({
        action_type: 'CREATE_DROP_TO_WAVE',
        end_time: null,
        wave_allowlist: ['wave-1', 'wave-2']
      });
      expect(res.status).toBe(200);
      expect(createAction).toHaveBeenCalledWith({
        proxy: expect.objectContaining({ id: 'proxy-1' }),
        action: {
          action_type: 'CREATE_DROP_TO_WAVE',
          end_time: null,
          wave_allowlist: ['wave-1', 'wave-2']
        }
      });
    });

    it('accepts an omitted or null allowlist as the legacy unrestricted grant', async () => {
      expect(
        (await create({ action_type: 'CREATE_DROP_TO_WAVE', end_time: null }))
          .status
      ).toBe(200);
      expect(
        (
          await create({
            action_type: 'CREATE_DROP_TO_WAVE',
            end_time: null,
            wave_allowlist: null
          })
        ).status
      ).toBe(200);
      expect(createAction).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['an empty list', []],
      ['duplicates', ['wave-1', 'wave-1']],
      ['a non-string entry', ['wave-1', 2]],
      ['an empty id', ['']],
      ['a string instead of a list', 'wave-1'],
      ['an object', { wave_id: 'wave-1' }],
      ['more than 100 entries', Array.from({ length: 101 }, (_, i) => `w${i}`)]
    ])(
      'rejects %s with 400 and creates nothing',
      async (_label, wave_allowlist) => {
        const res = await create({
          action_type: 'CREATE_DROP_TO_WAVE',
          end_time: null,
          wave_allowlist
        });
        expect(res.status).toBe(400);
        expect(createAction).not.toHaveBeenCalled();
      }
    );

    it('rejects an allowlist on another action type', async () => {
      const res = await create({
        action_type: 'CREATE_WAVE',
        end_time: null,
        wave_allowlist: ['wave-1']
      });
      expect(res.status).toBe(400);
      expect(createAction).not.toHaveBeenCalled();
    });
  });

  describe('PUT /proxies/:proxy_id/actions/:action_id', () => {
    const update = (body: unknown) =>
      send('PUT', '/proxies/proxy-1/actions/action-1', body);

    it('passes a replacement list to the service', async () => {
      const res = await update({ wave_allowlist: ['wave-3'] });
      expect(res.status).toBe(200);
      expect(updateAction).toHaveBeenCalledWith({
        proxy_id: 'proxy-1',
        action_id: 'action-1',
        credit_amount: undefined,
        end_time: undefined,
        wave_allowlist: ['wave-3'],
        profile_id: 'grantor'
      });
    });

    it('leaves the field undefined when omitted', async () => {
      await update({ end_time: 123 });
      expect(updateAction).toHaveBeenCalledWith(
        expect.objectContaining({ end_time: 123, wave_allowlist: undefined })
      );
    });

    it('rejects null (no lifting through update) and malformed lists with 400', async () => {
      for (const wave_allowlist of [null, [], ['a', 'a'], 'wave-1', [1]]) {
        const res = await update({ wave_allowlist });
        expect(res.status).toBe(400);
      }
      expect(updateAction).not.toHaveBeenCalled();
    });
  });
});
