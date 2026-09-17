import { handleRevokePushInstallation } from './revoke-push-installation.handler';
import { revokeInstallation } from './push-installation.db';
import { requestInstallationBadgeRefresh } from './push-notifications.service';
import { withDeviceBadgeLock } from '@/pushNotificationsHandler/device-badge';
import { RevokePushInstallationRequest } from '@/api/generated/routes/operations';

jest.mock('./push-installation.db', () => ({ revokeInstallation: jest.fn() }));
jest.mock('./push-notifications.service', () => ({
  requestInstallationBadgeRefresh: jest.fn()
}));
jest.mock('@/pushNotificationsHandler/device-badge', () => ({
  withDeviceBadgeLock: jest.fn()
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
  jest
    .mocked(withDeviceBadgeLock)
    .mockReset()
    .mockImplementation(async (_device, action) => action());
  jest.mocked(revokeInstallation).mockReset().mockResolvedValue({
    device_id: 'phone',
    revision: 1
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

it('accepts the maximum unsigned revision and rejects overflow before deletion', async () => {
  await handleRevokePushInstallation(
    request({ ...body, revision: 4294967295 })
  );
  expect(revokeInstallation).toHaveBeenCalledWith(
    { ...body, revision: 4294967295 },
    {}
  );
  jest.mocked(revokeInstallation).mockClear();
  await expect(
    handleRevokePushInstallation(request({ ...body, revision: 4294967296 }))
  ).rejects.toThrow();
  expect(revokeInstallation).not.toHaveBeenCalled();
});

it.each(['busy', 'unavailable'])(
  'preserves deletion for retry when Redis is %s',
  async (reason) => {
    jest.mocked(withDeviceBadgeLock).mockRejectedValueOnce(new Error(reason));
    await expect(handleRevokePushInstallation(request(body))).rejects.toThrow(
      reason
    );
    expect(revokeInstallation).not.toHaveBeenCalled();
    expect(requestInstallationBadgeRefresh).not.toHaveBeenCalled();
    await expect(handleRevokePushInstallation(request(body))).resolves.toEqual({
      revision: 1
    });
    expect(withDeviceBadgeLock).toHaveBeenCalledWith(
      { device_id: 'phone' },
      expect.any(Function)
    );
    expect(revokeInstallation).toHaveBeenCalledTimes(1);
  }
);

it('does not enqueue an obsolete badge correction during token-scoped migration', async () => {
  const migration = { ...body, token: 'current-token', token_scoped: true };
  await expect(
    handleRevokePushInstallation(request(migration))
  ).resolves.toEqual({ revision: 1 });
  expect(revokeInstallation).toHaveBeenCalledWith(migration, {});
  expect(requestInstallationBadgeRefresh).not.toHaveBeenCalled();
});
it('requires a token for migration cleanup before any mutation', async () => {
  await expect(
    handleRevokePushInstallation(request({ ...body, token_scoped: true }))
  ).rejects.toThrow();
  expect(revokeInstallation).not.toHaveBeenCalled();
});
