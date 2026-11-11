import { Request } from 'express';
import { putDropForgeSettings } from '@/api/drop-forge/drop-forge-settings.handlers';
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
const preparationOnly = {
  can_edit: false,
  can_edit_preparation: true,
  can_top_up: true
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getAuthenticatedWalletOrNull).mockReturnValue(testConfig.signer);
  jest.mocked(getDropForgeConfig).mockReturnValue(testConfig);
  jest.mocked(forgeSettingsAccess).mockResolvedValue(preparationOnly);
  jest.mocked(readForgeSettings).mockResolvedValue({
    id: 'settings',
    revision: 1,
    automation_enabled: false,
    preparation_enabled: true,
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

it('permits a distribution administrator to update preparation independently', async () => {
  const body = { revision: 0, preparation_enabled: true };
  expect(await putDropForgeSettings(request(body))).toMatchObject({
    preparation_enabled: true,
    ...preparationOnly
  });
  expect(updateForgeSettings).toHaveBeenCalledWith(
    testConfig,
    testConfig.signer,
    body
  );
});

it.each([
  { automation_enabled: false },
  { pay_artist_enabled: false },
  { max_artist_payment_eth: null }
])(
  'rejects a preparation edit combined with a restricted field (%j)',
  async (restricted) => {
    await expect(
      putDropForgeSettings(
        request({
          revision: 0,
          preparation_enabled: true,
          ...restricted
        })
      )
    ).rejects.toThrow('claims administrators');
    expect(updateForgeSettings).not.toHaveBeenCalled();
  }
);

it('rejects a preparation edit from a read-only on-chain admin', async () => {
  jest.mocked(forgeSettingsAccess).mockResolvedValue({
    ...preparationOnly,
    can_edit_preparation: false
  });
  await expect(
    putDropForgeSettings(request({ revision: 0, preparation_enabled: true }))
  ).rejects.toThrow('preparation settings access');
  expect(updateForgeSettings).not.toHaveBeenCalled();
});
