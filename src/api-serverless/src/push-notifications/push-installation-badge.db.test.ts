import { createHash } from 'node:crypto';
import { verifyBadgeRefreshInstallation } from './push-installation-badge.db';
import { sqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';

jest.mock('@/sql-executor', () => ({
  sqlExecutor: { oneOrNull: jest.fn() }
}));
const request = {
  device_id: 'phone',
  installation_secret: 'a'.repeat(64),
  revision: 2
};
const secret_hash = createHash('sha256')
  .update(request.installation_secret)
  .digest('hex');
beforeEach(() => {
  jest
    .mocked(sqlExecutor.oneOrNull)
    .mockReset()
    .mockResolvedValue({ secret_hash, revision: 2 });
});
it('verifies the established credential and current revision using the primary', async () => {
  await expect(
    verifyBadgeRefreshInstallation(request)
  ).resolves.toBeUndefined();
  expect(sqlExecutor.oneOrNull).toHaveBeenCalledWith(
    expect.stringMatching(/^SELECT secret_hash, revision FROM /),
    { device_id: 'phone' },
    { forcePool: DbPoolName.WRITE }
  );
});
it.each([
  null,
  { secret_hash: null, revision: 2 },
  { secret_hash: 'invalid', revision: 2 }
])(
  'rejects missing, unclaimed or malformed stored credentials',
  async (row) => {
    jest.mocked(sqlExecutor.oneOrNull).mockResolvedValue(row);
    await expect(verifyBadgeRefreshInstallation(request)).rejects.toThrow(
      'Invalid push installation credential'
    );
  }
);
it('rejects another installation secret', async () => {
  await expect(
    verifyBadgeRefreshInstallation({
      ...request,
      installation_secret: 'b'.repeat(64)
    })
  ).rejects.toThrow('Invalid push installation credential');
});
it.each([1, 3])('rejects a stale or future revision %s', async (revision) => {
  await expect(
    verifyBadgeRefreshInstallation({ ...request, revision })
  ).rejects.toThrow('Stale push installation revision');
});
