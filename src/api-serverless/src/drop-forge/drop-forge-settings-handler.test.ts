import { Request } from 'express';
import {
  getDropForgeSettings,
  putDropForgeSettings
} from '@/api/drop-forge/drop-forge-settings.handlers';
import { getAuthenticatedWalletOrNull } from '@/api/auth/auth';
import { getDropForgeConfig } from '@/drop-forge/drop-forge.config';
import { forgeSettingsAccess } from '@/drop-forge/drop-forge.access';
import {
  readForgeSettings,
  updateForgeSettings
} from '@/drop-forge/drop-forge.settings';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';

jest.mock('@/api/auth/auth');
jest.mock('@/drop-forge/drop-forge.config');
jest.mock('@/drop-forge/drop-forge.access');
jest.mock('@/drop-forge/drop-forge.settings', () => ({
  ...jest.requireActual('@/drop-forge/drop-forge.settings'),
  readForgeSettings: jest.fn(),
  updateForgeSettings: jest.fn()
}));
jest.mock('@/ethereum-rpc/ethereum-rpc-provider');

const request = (body: object) => ({ body }) as Request;
const readOnlyAccess = {
  can_edit: false,
  can_top_up: true
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getAuthenticatedWalletOrNull).mockReturnValue(testConfig.signer);
  jest.mocked(getDropForgeConfig).mockReturnValue(testConfig);
  jest.mocked(forgeSettingsAccess).mockResolvedValue(readOnlyAccess);
  jest.mocked(readForgeSettings).mockResolvedValue({
    id: 'settings',
    revision: 1,
    automation_enabled: false,
    pay_artist_enabled: false,
    max_artist_payment_wei: null,
    updated_by: testConfig.signer,
    updated_at: 1
  });
  jest.mocked(getEthereumRpcProvider).mockReturnValue({
    getBalance: jest.fn().mockResolvedValue(BigInt(0)),
    lookupAddress: jest.fn().mockResolvedValue(null)
  } as unknown as ReturnType<typeof getEthereumRpcProvider>);
});

it('returns the configured operations wave in the automation settings', async () => {
  await expect(getDropForgeSettings(request({}))).resolves.toMatchObject({
    operations_wave_id: testConfig.waveId
  });
});

it.each([
  { automation_enabled: false },
  { pay_artist_enabled: false },
  { max_artist_payment_eth: null }
])(
  'rejects a settings edit from a read-only administrator (%j)',
  async (restricted) => {
    await expect(
      putDropForgeSettings(
        request({
          revision: 0,
          ...restricted
        })
      )
    ).rejects.toThrow('claims administrators');
    expect(updateForgeSettings).not.toHaveBeenCalled();
  }
);

it('lets a claims administrator update launch settings', async () => {
  jest.mocked(forgeSettingsAccess).mockResolvedValue({
    ...readOnlyAccess,
    can_edit: true
  });
  const body = { revision: 0, automation_enabled: true };
  await putDropForgeSettings(request(body));
  expect(updateForgeSettings).toHaveBeenCalledWith(
    testConfig,
    testConfig.signer,
    body
  );
});
