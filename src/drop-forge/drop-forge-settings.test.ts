import { sqlExecutor } from '@/sql-executor';
import { updateForgeSettings } from '@/drop-forge/drop-forge.settings';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';
jest.mock('@/sql-executor', () => ({
  ...jest.requireActual<typeof import('@/sql-executor')>('@/sql-executor'),
  sqlExecutor: {
    execute: jest.fn(),
    oneOrNull: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn()
  }
}));
jest.mock('@/drop-forge/drop-forge.wake', () => ({ wakeDropForge: jest.fn() }));
const readSettings = jest.mocked(sqlExecutor.oneOrNull);
const config = { ...testConfig, maxArtistPayment: undefined };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(sqlExecutor.execute).mockResolvedValue([]);
  readSettings.mockResolvedValue({
    id: 'settings',
    revision: 3,
    automation_enabled: true,
    pay_artist_enabled: true,
    updated_by: null,
    updated_at: 0
  });
  jest
    .mocked(sqlExecutor.executeNativeQueriesInTransaction)
    .mockImplementation(async (work) => work({ connection: {} } as never));
});
it('allows switching launch execution Off after its payout cap is removed', async () => {
  const input = {
    revision: 3,
    automation_enabled: false,
    pay_artist_enabled: true
  };
  await expect(
    updateForgeSettings(config, testConfig.signer, input)
  ).resolves.toBeUndefined();
  const update = jest
    .mocked(sqlExecutor.execute)
    .mock.calls.find(([sql]) => sql.startsWith('UPDATE'));
  expect(update?.[1]).toMatchObject(input);
});
it('refuses resuming execution with artist payments enabled and no cap', async () => {
  await expect(
    updateForgeSettings(config, testConfig.signer, {
      revision: 3,
      automation_enabled: true,
      pay_artist_enabled: true
    })
  ).rejects.toThrow('payment limit');
  expect(
    jest
      .mocked(sqlExecutor.execute)
      .mock.calls.some(([sql]) => sql.startsWith('UPDATE'))
  ).toBe(false);
});
it('requires the cap for a new payment opt-in even while launch execution is Off', async () => {
  readSettings.mockResolvedValue({
    id: 'settings',
    revision: 3,
    automation_enabled: false,
    pay_artist_enabled: false
  });
  await expect(
    updateForgeSettings(config, testConfig.signer, {
      revision: 3,
      automation_enabled: false,
      pay_artist_enabled: true
    })
  ).rejects.toThrow('payment limit');
});
