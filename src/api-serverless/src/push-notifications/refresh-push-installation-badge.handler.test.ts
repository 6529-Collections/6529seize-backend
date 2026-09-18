import { handleRefreshPushInstallationBadge } from './refresh-push-installation-badge.handler';
import { verifyBadgeRefreshInstallation } from './push-installation-badge.db';
import {
  isActivated,
  requestInstallationBadgeRefresh
} from './push-notifications.service';
import { RefreshPushInstallationBadgeRequest } from '@/api/generated/routes/operations';

jest.mock('./push-installation-badge.db', () => ({
  verifyBadgeRefreshInstallation: jest.fn()
}));
jest.mock('./push-notifications.service', () => ({
  isActivated: jest.fn(),
  requestInstallationBadgeRefresh: jest.fn()
}));
const body = {
  device_id: 'phone',
  installation_secret: 'a'.repeat(64),
  revision: 0
};
const request = (value: unknown) =>
  ({ body: value }) as RefreshPushInstallationBadgeRequest;
beforeEach(() => {
  jest
    .mocked(verifyBadgeRefreshInstallation)
    .mockReset()
    .mockResolvedValue(undefined);
  jest.mocked(isActivated).mockReset().mockReturnValue(true);
  jest
    .mocked(requestInstallationBadgeRefresh)
    .mockReset()
    .mockResolvedValue(undefined);
});
it('verifies the installation before queueing only its device ID', async () => {
  await expect(
    handleRefreshPushInstallationBadge(request(body))
  ).resolves.toEqual({ queued: true });
  expect(verifyBadgeRefreshInstallation).toHaveBeenCalledWith(body);
  expect(requestInstallationBadgeRefresh).toHaveBeenCalledWith('phone');
  expect(
    jest.mocked(verifyBadgeRefreshInstallation).mock.invocationCallOrder[0]
  ).toBeLessThan(
    jest.mocked(requestInstallationBadgeRefresh).mock.invocationCallOrder[0]!
  );
});
it.each([
  { ...body, installation_secret: undefined },
  { ...body, installation_secret: 'bad' },
  { ...body, device_id: '' },
  { ...body, revision: -1 },
  { ...body, revision: 4294967296 },
  { ...body, badge: 69 }
])(
  'rejects invalid proof or client counts before any DB or queue work',
  async (value) => {
    await expect(
      handleRefreshPushInstallationBadge(request(value))
    ).rejects.toThrow();
    expect(verifyBadgeRefreshInstallation).not.toHaveBeenCalled();
    expect(requestInstallationBadgeRefresh).not.toHaveBeenCalled();
  }
);
it('does not enqueue when ownership verification fails', async () => {
  jest
    .mocked(verifyBadgeRefreshInstallation)
    .mockRejectedValue(new Error('invalid proof'));
  await expect(
    handleRefreshPushInstallationBadge(request(body))
  ).rejects.toThrow('invalid proof');
  expect(requestInstallationBadgeRefresh).not.toHaveBeenCalled();
});
it('reports disabled pushes without claiming queue acceptance', async () => {
  jest.mocked(isActivated).mockReturnValue(false);
  await expect(
    handleRefreshPushInstallationBadge(request(body))
  ).resolves.toEqual({ queued: false });
  expect(verifyBadgeRefreshInstallation).toHaveBeenCalledWith(body);
  expect(requestInstallationBadgeRefresh).not.toHaveBeenCalled();
});
it('propagates queue failure and permits a later retry with the same revision', async () => {
  jest
    .mocked(requestInstallationBadgeRefresh)
    .mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(
    handleRefreshPushInstallationBadge(request(body))
  ).rejects.toThrow('queue unavailable');
  await expect(
    handleRefreshPushInstallationBadge(request(body))
  ).resolves.toEqual({ queued: true });
});
