const mockRouterGet = jest.fn();
const mockRouterPost = jest.fn();
const mockRouterDelete = jest.fn();

jest.mock('@/api/async.router', () => ({
  asyncRouter: () => ({
    get: mockRouterGet,
    post: mockRouterPost,
    delete: mockRouterDelete
  })
}));

jest.mock('./policies.db', () => ({
  deleteCookiesConsent: jest.fn(),
  saveCookiesConsent: jest.fn(),
  deleteEULAConsent: jest.fn(),
  saveEULAConsent: jest.fn(),
  fetchEULAConsent: jest.fn()
}));

import { CURRENT_EULA_VERSION } from './eula-policy';
import {
  deleteEULAConsent,
  fetchEULAConsent,
  saveEULAConsent
} from './policies.db';
import { validateEULAConsentRequest } from './policies.routes';

const eulaPostHandler = mockRouterPost.mock.calls.find(
  ([path]) => path === '/eula-consent'
)![1];
const eulaGetHandler = mockRouterGet.mock.calls.find(
  ([path]) => path === '/eula-consent/:deviceId'
)![1];
const eulaDeleteHandler = mockRouterDelete.mock.calls.find(
  ([path]) => path === '/eula-consent'
)![1];

function makeResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis()
  };
}

describe('EULA consent routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates the complete current-version request', () => {
    expect(
      validateEULAConsentRequest({
        device_id: ' device-1 ',
        platform: ' ios ',
        eula_version: CURRENT_EULA_VERSION
      })
    ).toEqual({
      ok: true,
      value: {
        deviceId: 'device-1',
        platform: 'ios',
        eulaVersion: CURRENT_EULA_VERSION
      }
    });
  });

  it.each([
    {},
    { device_id: '', platform: 'ios', eula_version: CURRENT_EULA_VERSION },
    {
      device_id: 'device-1',
      platform: '',
      eula_version: CURRENT_EULA_VERSION
    },
    { device_id: 'device-1', platform: 'ios' },
    {
      device_id: 'device-1',
      platform: 'ios',
      eula_version: 'stale-version'
    },
    {
      device_id: 'device-1',
      platform: 'android',
      eula_version: CURRENT_EULA_VERSION
    },
    {
      device_id: 123,
      platform: 'ios',
      eula_version: CURRENT_EULA_VERSION
    }
  ])('rejects malformed or stale acceptance payloads', (body) => {
    expect(validateEULAConsentRequest(body)).toEqual({ ok: false });
  });

  it('persists a valid acceptance before returning success', async () => {
    const res = makeResponse();
    (saveEULAConsent as jest.Mock).mockResolvedValue(undefined);

    await eulaPostHandler(
      {
        body: {
          device_id: 'device-1',
          platform: 'ios',
          eula_version: CURRENT_EULA_VERSION
        }
      },
      res
    );

    expect(saveEULAConsent).toHaveBeenCalledWith(
      'device-1',
      'ios',
      CURRENT_EULA_VERSION
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({
      message: 'EULA consent saved',
      eula_version: CURRENT_EULA_VERSION
    });
  });

  it('returns 400 and does not persist an invalid acceptance', async () => {
    const res = makeResponse();

    await eulaPostHandler(
      {
        body: {
          device_id: 'device-1',
          platform: 'ios',
          eula_version: 'old-version'
        }
      },
      res
    );

    expect(saveEULAConsent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns only the acceptance selected by the current-version DB filter', async () => {
    const consent = {
      device_id: 'device-1',
      platform: 'ios',
      accepted_at: 1_777_000_000_000,
      eula_version: CURRENT_EULA_VERSION
    };
    const res = makeResponse();
    (fetchEULAConsent as jest.Mock).mockResolvedValue(consent);

    await eulaGetHandler({ params: { deviceId: 'device-1' } }, res);

    expect(fetchEULAConsent).toHaveBeenCalledWith('device-1');
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith(consent);
  });

  it('returns an empty object for missing, stale, or expired acceptance', async () => {
    const res = makeResponse();
    (fetchEULAConsent as jest.Mock).mockResolvedValue(null);

    await eulaGetHandler({ params: { deviceId: 'device-1' } }, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith({});
  });

  it('validates and normalizes the device id before deleting consent', async () => {
    const res = makeResponse();
    (deleteEULAConsent as jest.Mock).mockResolvedValue(undefined);

    await eulaDeleteHandler({ body: { device_id: ' device-1 ' } }, res);

    expect(deleteEULAConsent).toHaveBeenCalledWith('device-1');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each([
    {},
    { device_id: '' },
    { device_id: 123 },
    { device_id: 'x'.repeat(101) }
  ])('rejects an invalid device id when deleting consent', async (body) => {
    const res = makeResponse();

    await eulaDeleteHandler({ body }, res);

    expect(deleteEULAConsent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
