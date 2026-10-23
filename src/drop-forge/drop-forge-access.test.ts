import { Interface, JsonRpcProvider } from 'ethers';
import * as settings from '@/api/seize-settings';
import * as rpc from '@/ethereum-rpc/ethereum-rpc-provider';
import { forgeSettingsAccess } from '@/drop-forge/drop-forge.access';
import { testConfig } from '@/drop-forge/drop-forge.test-fixtures';

const abi = new Interface([
  'function owner() view returns (address)',
  'function isAdmin(address) view returns (bool)'
]);
const other = '0x' + 'aa'.repeat(20);
beforeEach(() => {
  jest.spyOn(settings, 'getClaimsAdminWallets').mockReturnValue([]);
  jest.spyOn(settings, 'getDistributionAdminWallets').mockReturnValue([]);
});
function chain(owner: string, admin: boolean) {
  const call = jest.fn(async ({ data }: { data: string }) =>
    data === abi.encodeFunctionData('owner')
      ? abi.encodeFunctionResult('owner', [owner])
      : abi.encodeFunctionResult('isAdmin', [admin])
  );
  jest
    .spyOn(rpc, 'getEthereumRpcProvider')
    .mockReturnValue({ call } as unknown as JsonRpcProvider);
  return call;
}
it('permits claims-list admins to edit without on-chain admin authority', async () => {
  jest
    .spyOn(settings, 'getClaimsAdminWallets')
    .mockReturnValue([testConfig.signer.toLowerCase()]);
  expect(await forgeSettingsAccess(testConfig, testConfig.signer)).toEqual({
    can_edit: true,
    can_top_up: true
  });
});
it('permits the creator owner to edit', async () => {
  chain(testConfig.signer, false);
  expect(
    (await forgeSettingsAccess(testConfig, testConfig.signer)).can_edit
  ).toBe(true);
});
it('permits ordinary on-chain admins to view and fund, without editing', async () => {
  chain(other, true);
  expect(await forgeSettingsAccess(testConfig, testConfig.signer)).toEqual({
    can_edit: false,
    can_top_up: true
  });
});
it('permits distribution-list admins to view and fund, without editing', async () => {
  chain(other, false);
  jest
    .spyOn(settings, 'getDistributionAdminWallets')
    .mockReturnValue([testConfig.signer]);
  expect(await forgeSettingsAccess(testConfig, testConfig.signer)).toEqual({
    can_edit: false,
    can_top_up: true
  });
});
it('rejects unrelated and disconnected wallets', async () => {
  chain(other, false);
  await expect(
    forgeSettingsAccess(testConfig, testConfig.signer)
  ).rejects.toThrow('administrator');
  await expect(forgeSettingsAccess(testConfig, null)).rejects.toThrow(
    'administrator'
  );
});

afterEach(() => jest.restoreAllMocks());
