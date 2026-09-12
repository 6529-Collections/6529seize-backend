jest.mock('./policies.db', () => ({
  deleteEULAConsent: jest.fn(),
  fetchEULAConsent: jest.fn(),
  saveEULAConsent: jest.fn()
}));

import {
  DeleteEulaConsentRequest,
  GetEulaConsentRequest,
  SaveEulaConsentRequest
} from '@/api/generated/routes/operations';
import { BadRequestException } from '@/exceptions';
import {
  handleDeleteEulaConsent,
  handleGetEulaConsent,
  handleSaveEulaConsent
} from './eula-consent.handlers';
import { CURRENT_EULA_VERSION } from './eula-policy';
import {
  deleteEULAConsent,
  fetchEULAConsent,
  saveEULAConsent
} from './policies.db';

const saveRequest = (body: unknown) => ({ body }) as SaveEulaConsentRequest;
const deleteRequest = (body: unknown) => ({ body }) as DeleteEulaConsentRequest;
const getRequest = (deviceId: unknown) =>
  ({ params: { deviceId } }) as GetEulaConsentRequest;

describe('EULA consent handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists a normalized current-version acceptance', async () => {
    (saveEULAConsent as jest.Mock).mockResolvedValue(undefined);

    await expect(
      handleSaveEulaConsent(
        saveRequest({
          device_id: ' device-1 ',
          platform: ' ios ',
          eula_version: CURRENT_EULA_VERSION
        })
      )
    ).resolves.toEqual({
      message: 'EULA consent saved',
      eula_version: CURRENT_EULA_VERSION
    });
    expect(saveEULAConsent).toHaveBeenCalledWith(
      'device-1',
      'ios',
      CURRENT_EULA_VERSION
    );
  });

  it('accepts a bounded, non-empty non-iOS platform', async () => {
    (saveEULAConsent as jest.Mock).mockResolvedValue(undefined);

    await handleSaveEulaConsent(
      saveRequest({
        device_id: 'device-1',
        platform: ' android ',
        eula_version: CURRENT_EULA_VERSION
      })
    );

    expect(saveEULAConsent).toHaveBeenCalledWith(
      'device-1',
      'android',
      CURRENT_EULA_VERSION
    );
  });

  it.each([
    {},
    { device_id: '', platform: 'ios', eula_version: CURRENT_EULA_VERSION },
    {
      device_id: 'device-1',
      platform: '',
      eula_version: CURRENT_EULA_VERSION
    },
    {
      device_id: 'device-1',
      platform: 'x'.repeat(33),
      eula_version: CURRENT_EULA_VERSION
    },
    { device_id: 'device-1', platform: 'ios' },
    {
      device_id: 'device-1',
      platform: 'ios',
      eula_version: 'stale-version'
    },
    {
      device_id: 123,
      platform: 'ios',
      eula_version: CURRENT_EULA_VERSION
    },
    {
      device_id: 'device-1',
      platform: 'ios',
      eula_version: CURRENT_EULA_VERSION,
      unexpected: true
    }
  ])('rejects malformed or stale acceptance payloads', async (body) => {
    await expect(
      handleSaveEulaConsent(saveRequest(body))
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(saveEULAConsent).not.toHaveBeenCalled();
  });

  it('returns the current acceptance selected by the DB filter', async () => {
    const consent = {
      device_id: 'device-1',
      platform: 'ios',
      accepted_at: 1_777_000_000_000,
      eula_version: CURRENT_EULA_VERSION
    };
    (fetchEULAConsent as jest.Mock).mockResolvedValue(consent);

    await expect(
      handleGetEulaConsent(getRequest(' device-1 '))
    ).resolves.toEqual(consent);
    expect(fetchEULAConsent).toHaveBeenCalledWith('device-1');
  });

  it('returns an empty object for missing, stale, or expired acceptance', async () => {
    (fetchEULAConsent as jest.Mock).mockResolvedValue(null);

    await expect(handleGetEulaConsent(getRequest('device-1'))).resolves.toEqual(
      {}
    );
  });

  it.each(['', 'x'.repeat(101), 123])(
    'rejects an invalid device id when retrieving consent',
    async (deviceId) => {
      await expect(
        handleGetEulaConsent(getRequest(deviceId))
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchEULAConsent).not.toHaveBeenCalled();
    }
  );

  it('normalizes the device id before deleting consent', async () => {
    (deleteEULAConsent as jest.Mock).mockResolvedValue(undefined);

    await expect(
      handleDeleteEulaConsent(deleteRequest({ device_id: ' device-1 ' }))
    ).resolves.toEqual({ message: 'EULA consent deleted' });
    expect(deleteEULAConsent).toHaveBeenCalledWith('device-1');
  });

  it.each([
    {},
    { device_id: '' },
    { device_id: 123 },
    { device_id: 'x'.repeat(101) },
    { device_id: 'device-1', unexpected: true }
  ])('rejects an invalid delete request', async (body) => {
    await expect(
      handleDeleteEulaConsent(deleteRequest(body))
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(deleteEULAConsent).not.toHaveBeenCalled();
  });
});
