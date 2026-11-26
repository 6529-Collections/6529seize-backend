import express from 'express';
import { AddressInfo } from 'node:net';
import * as http from 'node:http';
import { wavesFreezeMiddleware } from '@/api/waves-freeze/waves-freeze.middleware';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import { Time } from '@/time';
import {
  WAVES_FROZEN_CODE,
  WAVES_FROZEN_MESSAGE,
  WAVES_ON_CHAIN_CODE,
  WAVES_ON_CHAIN_MESSAGE
} from '@/waves-freeze/waves-freeze';
import {
  WAVES_POLLS_PAUSED_CODE,
  WAVES_POLLS_PAUSED_MESSAGE
} from '@/waves-freeze/waves-chain-polls';

const ENV_NAMES = [
  'FEATURE_WAVES_FROZEN',
  'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE',
  'WAVES_FREEZE_AT',
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'FEATURE_WAVES_CHAIN_POLLS'
];
const FREEZE = Date.UTC(2026, 10, 27);
const SWITCH_ON = Date.UTC(2026, 10, 28);

const ON_CHAIN = { error: WAVES_ON_CHAIN_MESSAGE, code: WAVES_ON_CHAIN_CODE };
const FROZEN = { error: WAVES_FROZEN_MESSAGE, code: WAVES_FROZEN_CODE };
const REACHED = { reached: true };

/** Every write the middleware refuses, in a wave that moves (w-1). */
const MOVED_WAVE_WRITES = [
  ['POST', '/api/v2/waves/w-1/metadata', { data_key: 'k', data_value: 'v' }],
  ['DELETE', '/api/v2/waves/w-1/metadata/m-1', undefined],
  ['POST', '/api/waves/w-1/rep/rating', { amount: 1 }],
  ['POST', '/api/v3/waves/w-1/competitions', {}],
  ['PATCH', '/api/v3/waves/w-1/competitions/c-1', {}],
  ['POST', '/api/v3/waves/w-1/competitions/c-1/actions/PAUSE', {}],
  ['POST', '/api/v3/waves/w-1/competitions/c-1/entries', {}],
  ['PUT', '/api/v3/waves/w-1/competitions/c-1/entries/e-1/votes/me', {}],
  ['POST', '/api/drops', { drop_type: 'PARTICIPATORY', wave_id: 'w-1' }]
] as const;

const NEW_POLL = { drop_type: 'CHAT', wave_id: 'w-1', poll: { options: [] } };

describe('wavesFreezeMiddleware from the switch-on', () => {
  const saved: Record<string, string | undefined> = {};
  let server: http.Server;
  let port: number;
  let now: jest.SpyInstance;

  beforeAll(async () => {
    for (const name of ENV_NAMES) saved[name] = process.env[name];
    const app = express();
    app.use(express.json());
    const apiRouter = express.Router();
    // 'staying' stays on 6529.io; every other wave moves. Drop d-moving is
    // in a moving wave.
    apiRouter.use(
      wavesFreezeMiddleware({
        waveStays: async (waveId) => waveId === 'staying',
        dropWaveId: async (dropId) =>
          ({ 'd-staying': 'staying', 'd-moving': 'w-1' })[dropId] ?? null
      })
    );
    apiRouter.use((_req, res) => {
      res.status(200).send(REACHED);
    });
    app.use('/api', apiRouter);
    app.use(customErrorMiddleware());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  beforeEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.WAVES_FREEZE_AT = new Date(FREEZE).toISOString();
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
  });
  afterEach(() => now.mockRestore());

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

  it('answers every write to a moved wave with 423 WAVES_ON_CHAIN', async () => {
    for (const [method, path, body] of MOVED_WAVE_WRITES) {
      expect(await call(method, path, body)).toEqual({
        status: 423,
        body: ON_CHAIN
      });
    }
  });

  it('answers a new poll in a moved wave with the poll guard while polls are paused', async () => {
    expect(await call('POST', '/api/drops', NEW_POLL)).toEqual({
      status: 423,
      body: { error: WAVES_POLLS_PAUSED_MESSAGE, code: WAVES_POLLS_PAUSED_CODE }
    });
    expect(WAVES_POLLS_PAUSED_MESSAGE).toBe(
      "New polls in this wave aren't open yet."
    );
  });

  it('answers a new poll with WAVES_ON_CHAIN once chain polls show', async () => {
    process.env.FEATURE_WAVES_CHAIN_POLLS = 'true';
    expect(await call('POST', '/api/drops', NEW_POLL)).toEqual({
      status: 423,
      body: ON_CHAIN
    });
  });

  it('leaves a poll ballot to the poll service', async () => {
    expect(
      await call('POST', '/api/v2/drops/d-moving/poll/vote', { options: [1] })
    ).toEqual({ status: 200, body: REACHED });
  });

  it('lets writes to a staying wave, chat and new waves through', async () => {
    for (const [method, path, body] of [
      ['POST', '/api/waves/staying/rep/rating', { amount: 1 }],
      [
        'PUT',
        '/api/v3/waves/staying/competitions/c-1/entries/e-1/votes/me',
        {}
      ],
      ['POST', '/api/drops', { ...NEW_POLL, wave_id: 'staying' }],
      ['POST', '/api/drops', { drop_type: 'CHAT', wave_id: 'w-1' }],
      ['POST', '/api/waves', { name: 'new' }]
    ] as const) {
      expect(await call(method, path, body)).toEqual({
        status: 200,
        body: REACHED
      });
    }
  });

  it('answers as the freeze did before the switch-on: WAVES_FROZEN, ballots and polls included', async () => {
    now.mockReturnValue(SWITCH_ON - 1);
    for (const [method, path, body] of [
      ...MOVED_WAVE_WRITES,
      ['POST', '/api/drops', NEW_POLL],
      ['POST', '/api/v2/drops/d-moving/poll/vote', { options: [1] }]
    ] as const) {
      expect(await call(method, path, body)).toEqual({
        status: 423,
        body: FROZEN
      });
    }
  });
});
