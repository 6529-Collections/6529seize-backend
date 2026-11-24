import express from 'express';
import { AddressInfo } from 'node:net';
import * as http from 'node:http';
import {
  classifyWavesWrite,
  isRefusedByWavesFreeze,
  wavesFreezeMiddleware
} from '@/api/waves-freeze/waves-freeze.middleware';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import {
  WAVES_FROZEN_CODE,
  WAVES_FROZEN_MESSAGE
} from '@/waves-freeze/waves-freeze';

const FLAG = 'FEATURE_WAVES_FROZEN';
const KEEP = 'FEATURE_WAVES_FREEZE_KEEP_MAIN_STAGE';
const AT = 'WAVES_FREEZE_AT';
const MAIN_STAGE_WAVE = 'MAIN_STAGE_WAVE_ID';
const ENV_NAMES = [FLAG, KEEP, AT, MAIN_STAGE_WAVE];

function saveEnv() {
  const saved: Record<string, string | undefined> = {};
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  return () => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  };
}

describe('classifyWavesWrite', () => {
  it.each([
    ['POST', '/waves'],
    ['POST', '/waves/'],
    ['POST', '/Waves'],
    ['POST', '/v3/waves'],
    ['POST', '/v2/waves/wave-1/metadata'],
    ['DELETE', '/v2/waves/wave-1/metadata/7'],
    ['POST', '/waves/wave-1/rep/rating'],
    ['POST', '/v2/drops/drop-1/poll/vote'],
    ['POST', '/v3/waves/wave-1/competitions'],
    ['post', '/v3/waves/wave-1/competitions/']
  ])('counts %s %s as a wave write', (method, path) => {
    expect(classifyWavesWrite({ method, path })).toBe('WAVE');
  });

  it.each([
    ['PATCH', '/v3/waves/wave-1/competitions/comp-1'],
    ['POST', '/v3/waves/wave-1/competitions/comp-1/actions/publish'],
    ['POST', '/v3/waves/wave-1/competitions/comp-1/actions/pause'],
    ['POST', '/v3/waves/wave-1/competitions/comp-1/entries'],
    ['PUT', '/v3/waves/wave-1/competitions/comp-1/entries/entry-1/votes/me']
  ])('counts %s %s as a decision write', (method, path) => {
    expect(classifyWavesWrite({ method, path })).toBe('DECISION');
  });

  it('decides a new drop by its body', () => {
    const post = (body: unknown) =>
      classifyWavesWrite({ method: 'POST', path: '/drops', body });
    expect(post({ drop_type: 'CHAT', wave_id: 'w' })).toBeNull();
    expect(post({ wave_id: 'w', poll: null })).toBeNull();
    expect(post(undefined)).toBeNull();
    expect(post('text')).toBeNull();
    expect(post([])).toBeNull();
    expect(post({ drop_type: 'CHAT', poll: { options: ['a', 'b'] } })).toBe(
      'WAVE'
    );
    expect(post({ drop_type: 'PARTICIPATORY', wave_id: 'w' })).toBe('DECISION');
    expect(post({ drop_type: 'participatory' })).toBe('DECISION');
  });

  it.each([
    ['GET', '/waves'],
    ['HEAD', '/v3/waves/wave-1/competitions'],
    ['OPTIONS', '/waves/wave-1/rep/rating'],
    ['GET', '/v2/drops/drop-1/poll/vote'],
    // Chat, direct messages and personal state.
    ['POST', '/drops/drop-1'],
    ['DELETE', '/drops/drop-1'],
    ['POST', '/drops/drop-1/reaction'],
    ['DELETE', '/drops/drop-1/reaction'],
    ['POST', '/drops/drop-1/curations'],
    ['POST', '/drops/drop-1/bookmark'],
    ['POST', '/waves/direct-message/new'],
    ['POST', '/waves/wave-1/subscriptions'],
    ['DELETE', '/waves/wave-1/subscriptions'],
    ['POST', '/waves/wave-1/pins'],
    // The service refuses it for a wave and lets a direct message through.
    ['POST', '/waves/wave-1/pinned-drop'],
    ['POST', '/waves/wave-1/mute'],
    ['POST', '/waves/wave-1/curations'],
    ['POST', '/waves/wave-1/my-chat-history'],
    ['POST', '/wave-media/prep'],
    ['POST', '/drop-media/prep'],
    // A rating on a chat drop is a reaction: the vote service decides.
    ['POST', '/drops/drop-1/ratings'],
    // The legacy pause routes change nothing (they ignore the command).
    ['POST', '/waves/wave-1/pauses'],
    ['DELETE', '/waves/wave-1/pauses/3'],
    // Left to the services, which know a direct message from a wave.
    ['POST', '/waves/wave-1'],
    ['DELETE', '/waves/wave-1'],
    ['PATCH', '/v3/waves/wave-1'],
    // Left to the group service, which knows the groups waves use.
    ['POST', '/groups'],
    ['POST', '/groups/group-1/visible'],
    // Validation only.
    ['POST', '/v3/waves/wave-1/competitions/comp-1/main-stage-traits/validate'],
    ['POST', '/wave-group-validation'],
    // Identity writes are the identity freeze's.
    ['POST', '/profiles/someone/rep/rating'],
    ['POST', '/waves-overview']
  ])('lets %s %s through', (method, path) => {
    expect(classifyWavesWrite({ method, path })).toBeNull();
  });
});

describe('isRefusedByWavesFreeze', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = saveEnv();
    for (const name of ENV_NAMES) delete process.env[name];
  });
  afterEach(() => restore());

  it('refuses nothing when waves are not frozen', () => {
    for (const kind of ['WAVE', 'DECISION', null] as const) {
      expect(isRefusedByWavesFreeze(kind)).toBe(false);
    }
  });

  it('refuses every waves write while frozen', () => {
    process.env[FLAG] = 'true';
    expect(isRefusedByWavesFreeze('WAVE')).toBe(true);
    expect(isRefusedByWavesFreeze('DECISION')).toBe(true);
    expect(isRefusedByWavesFreeze(null)).toBe(false);
  });

  it('leaves decision writes to the services when the Main Stage is kept', () => {
    process.env[FLAG] = 'true';
    process.env[KEEP] = 'true';
    expect(isRefusedByWavesFreeze('DECISION')).toBe(false);
    expect(isRefusedByWavesFreeze('WAVE')).toBe(true);
  });
});

describe('wavesFreezeMiddleware', () => {
  let restore: () => void;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const apiRouter = express.Router();
    apiRouter.use(wavesFreezeMiddleware());
    const reached = (_req: express.Request, res: express.Response) => {
      res.status(200).send({ reached: true });
    };
    apiRouter.post('/waves', reached);
    apiRouter.get('/waves/:id', reached);
    apiRouter.post('/waves/:id', reached);
    apiRouter.post('/waves/:id/rep/rating', reached);
    apiRouter.post('/drops', reached);
    apiRouter.post('/drops/:id/reaction', reached);
    apiRouter.put(
      '/v3/waves/:waveId/competitions/:competitionId/entries/:entryId/votes/me',
      reached
    );
    app.use('/api', apiRouter);
    app.use(customErrorMiddleware());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    restore = saveEnv();
    for (const name of ENV_NAMES) delete process.env[name];
  });
  afterEach(() => restore());

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

  const vote = '/api/v3/waves/main-wave/competitions/c-1/entries/e-1/votes/me';

  it('refuses waves writes with 423 and the freeze code when on', async () => {
    process.env[FLAG] = 'true';
    for (const [method, path, body] of [
      ['POST', '/api/waves', { name: 'A wave' }],
      ['POST', '/api/waves/w-1/rep/rating', { amount: 1 }],
      ['POST', '/api/drops', { drop_type: 'CHAT', poll: { options: [] } }],
      ['PUT', vote, { value: 1 }]
    ] as const) {
      const response = await call(method, path, body);
      expect(response.status).toBe(423);
      expect(response.body).toEqual({
        error: WAVES_FROZEN_MESSAGE,
        code: WAVES_FROZEN_CODE
      });
    }
  });

  it('keeps chat and reads working when on', async () => {
    process.env[FLAG] = 'true';
    expect((await call('GET', '/api/waves/w-1')).status).toBe(200);
    expect(
      (await call('POST', '/api/drops', { drop_type: 'CHAT', wave_id: 'w' }))
        .status
    ).toBe(200);
    expect(
      (await call('POST', '/api/drops/d-1/reaction', { reaction: ':+1:' }))
        .status
    ).toBe(200);
    // A wave edit reaches the wave service, which tells a DM from a wave.
    expect((await call('POST', '/api/waves/w-1', {})).status).toBe(200);
  });

  it('passes decision writes to the services when the Main Stage is kept', async () => {
    process.env[FLAG] = 'true';
    process.env[KEEP] = 'true';
    expect((await call('PUT', vote, { value: 1 })).status).toBe(200);
    expect((await call('POST', '/api/waves', {})).status).toBe(423);
  });

  it.each([undefined, 'false', 'TRUE', '1', ''])(
    'changes nothing when the flag is %s',
    async (value) => {
      if (value !== undefined) process.env[FLAG] = value;
      expect((await call('POST', '/api/waves', {})).status).toBe(200);
      expect((await call('PUT', vote, { value: 1 })).status).toBe(200);
    }
  );
});
