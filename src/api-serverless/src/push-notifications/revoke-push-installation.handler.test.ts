import { handleRevokePushInstallation } from './revoke-push-installation.handler';
import { revokeInstallation } from './push-installation.db';
import { requestInstallationBadgeRefresh } from './push-notifications.service';
import { RevokePushInstallationRequest } from '@/api/generated/routes/operations';

jest.mock('./push-installation.db', () => ({ revokeInstallation: jest.fn() }));
jest.mock('./push-notifications.service', () => ({
  requestInstallationBadgeRefresh: jest.fn()
}));
jest.mock('@/pushNotificationsHandler/device-badge', () => ({
  withDeviceBadgeLock: async (
    _device: unknown,
    action: () => Promise<unknown>
  ) => action()
}));
const body = {
  device_id: 'phone',
  installation_secret: 'a'.repeat(64),
  revision: 1,
  all_profiles: true,
  sessions: []
};
const request = (value: unknown) =>
  ({ body: value }) as RevokePushInstallationRequest;
beforeEach(() => {
  jest.mocked(revokeInstallation).mockReset().mockResolvedValue({
    device_id: 'phone',
    revision: 1,
    secret_hash: 'hash',
    token: 'token',
    platform: 'ios'
  });
  jest
    .mocked(requestInstallationBadgeRefresh)
    .mockReset()
    .mockResolvedValue(undefined);
});
it('accepts installation proof without a wallet session and enqueues its badge update', async () => {
  expect(await handleRevokePushInstallation(request(body))).toEqual({
    revision: 1
  });
  expect(revokeInstallation).toHaveBeenCalledWith(body, {});
  expect(requestInstallationBadgeRefresh).toHaveBeenCalledWith('phone');
});
it('rejects device ID alone before deletion', async () => {
  await expect(
    handleRevokePushInstallation(
      request({ ...body, installation_secret: undefined })
    )
  ).rejects.toThrow();
  expect(revokeInstallation).not.toHaveBeenCalled();
});
it('does not enqueue when installation proof fails', async () => {
  jest.mocked(revokeInstallation).mockRejectedValue(new Error('invalid proof'));
  await expect(handleRevokePushInstallation(request(body))).rejects.toThrow(
    'invalid proof'
  );
  expect(requestInstallationBadgeRefresh).not.toHaveBeenCalled();
});
it('propagates queue failure so the persisted client request can retry', async () => {
  jest
    .mocked(requestInstallationBadgeRefresh)
    .mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(handleRevokePushInstallation(request(body))).rejects.toThrow(
    'queue unavailable'
  );
  expect(await handleRevokePushInstallation(request(body))).toEqual({
    revision: 1
  });
  expect(requestInstallationBadgeRefresh).toHaveBeenCalledTimes(2);
});
