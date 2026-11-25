import { assertLaunchAccess, getLaunch } from '@/drop-forge/drop-forge.service';
import { dropForgeRepository } from '@/drop-forge/drop-forge.repository';
import * as chain from '@/drop-forge/drop-forge.chain';
import * as rpc from '@/ethereum-rpc/ethereum-rpc-provider';
import { getDropForgePolicy } from '@/drop-forge/drop-forge.policy';
const old = { ...process.env };
afterEach(() => {
  process.env = { ...old };
  jest.restoreAllMocks();
});
it('permits launch lookup without configuring a signing key', async () => {
  process.env.DROP_FORGE_STAGE = 'staging';
  delete process.env.DROP_FORGE_KMS_KEY_ID;
  jest.spyOn(dropForgeRepository, 'find').mockResolvedValue(null);
  await expect(
    getLaunch(getDropForgePolicy().creator, 564, {})
  ).rejects.toThrow('Launch not found');
});
it('checks creator-admin access without wallet or wave secrets', async () => {
  process.env.DROP_FORGE_STAGE = 'staging';
  delete process.env.DROP_FORGE_KMS_KEY_ID;
  const admin = jest.spyOn(chain, 'creatorAdmin').mockResolvedValue(true);
  jest
    .spyOn(rpc, 'getEthereumRpcProvider')
    .mockReturnValue({} as ReturnType<typeof rpc.getEthereumRpcProvider>);
  await expect(
    assertLaunchAccess(
      '0x1111111111111111111111111111111111111111',
      getDropForgePolicy().creator
    )
  ).resolves.toBeUndefined();
  expect(admin).toHaveBeenCalled();
});
