const mockRoutes: { method: string; path: string; handler: any }[] = [];

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => {
    const register =
      (method: string) =>
      (path: string, ...handlers: any[]) => {
        mockRoutes.push({ method, path, handler: handlers.at(-1) });
      };
    return {
      get: register('get'),
      post: register('post'),
      put: register('put'),
      delete: register('delete'),
      use: jest.fn()
    };
  }
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: jest.fn(),
  needsAuthenticatedUser: () => jest.fn(),
  maybeAuthenticatedUser: () => jest.fn()
}));

jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('./wave.api.service', () => ({
  waveApiService: {
    updateWaveHub: jest.fn(),
    findWaveByIdOrThrow: jest.fn()
  }
}));

jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([])
  }
}));

import { getAuthenticationContext } from '@/api/auth/auth';
import { AuthenticationContext } from '@/auth-context';
import { ForbiddenException } from '@/exceptions';
import { Time } from '@/time';
import {
  WAVES_ON_CHAIN_CODE,
  WavesOnChainException
} from '@/waves-freeze/waves-freeze';
import { stubWavesScope } from '@/tests/fixtures/waves-scope.fixture';
import { waveApiService } from './wave.api.service';
import './waves.routes';

const NAMES = [
  'FEATURE_WAVES_ON_CHAIN',
  'WAVES_SWITCH_ON_AT',
  'WAVES_FREEZE_AT'
];
const SWITCH_ON = Date.UTC(2026, 10, 28);
const WAVE = { id: 'a wave as shown' };

function route(method: string, path: string) {
  return mockRoutes.find((it) => it.method === method && it.path === path)!
    .handler;
}

/** The two legacy decision pause routes, for one wave. */
const PAUSES = [
  ['post', '/:id/pauses', (waveId: string) => ({ id: waveId })],
  [
    'delete',
    '/:waveId/pauses/:id',
    (waveId: string) => ({ waveId, id: 'pause-1' })
  ]
] as const;

async function call(
  method: string,
  path: string,
  params: Record<string, string>
) {
  const res = { send: jest.fn() };
  await route(method, path)({ params, body: {}, query: {} }, res);
  return res;
}

describe('legacy decision pause routes from the switch-on', () => {
  const original: Record<string, string | undefined> = {};
  let now: jest.SpyInstance;
  beforeAll(() => {
    for (const name of NAMES) original[name] = process.env[name];
  });
  beforeEach(() => {
    jest.clearAllMocks();
    for (const name of NAMES) delete process.env[name];
    process.env.WAVES_SWITCH_ON_AT = new Date(SWITCH_ON).toISOString();
    now = jest.spyOn(Time, 'currentMillis').mockReturnValue(SWITCH_ON + 1);
    stubWavesScope({ staying: ['staying-wave'] });
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('admin'));
    jest.mocked(waveApiService.updateWaveHub).mockResolvedValue({} as any);
    jest
      .mocked(waveApiService.findWaveByIdOrThrow)
      .mockResolvedValue(WAVE as any);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    for (const name of NAMES) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  });

  it.each(PAUSES)(
    'answers %s %s in a moved wave with 423 WAVES_ON_CHAIN, after the admin check',
    async (method, path, params) => {
      const error = await call(method, path, params('moved-wave')).catch(
        (e) => e
      );
      expect(error).toBeInstanceOf(WavesOnChainException);
      expect(error.getStatusCode()).toBe(423);
      expect(error.code).toBe(WAVES_ON_CHAIN_CODE);
      expect(waveApiService.updateWaveHub).toHaveBeenCalledWith(
        'moved-wave',
        {},
        expect.anything()
      );
      expect(waveApiService.findWaveByIdOrThrow).not.toHaveBeenCalled();
    }
  );

  it.each(PAUSES)(
    'keeps the admin check first for %s %s',
    async (method, path, params) => {
      jest
        .mocked(waveApiService.updateWaveHub)
        .mockRejectedValue(
          new ForbiddenException('Only wave administrators can edit a wave')
        );
      await expect(
        call(method, path, params('moved-wave'))
      ).rejects.toBeInstanceOf(ForbiddenException);
    }
  );

  it.each(PAUSES)(
    'answers %s %s as before in a staying wave, and before the switch-on',
    async (method, path, params) => {
      expect(
        (await call(method, path, params('staying-wave'))).send
      ).toHaveBeenCalledWith(WAVE);
      now.mockReturnValue(SWITCH_ON - 1);
      expect(
        (await call(method, path, params('moved-wave'))).send
      ).toHaveBeenCalledWith(WAVE);
    }
  );
});
