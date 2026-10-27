import { rpcWithDeadline } from '@/drop-forge/drop-forge.chain';
import { Interface } from 'ethers';
import {
  getClaimsAdminWallets,
  getDistributionAdminWallets
} from '@/api/seize-settings';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import { DropForgeConfig } from '@/drop-forge/drop-forge.config';
import { ForbiddenException } from '@/exceptions';

const accessAbi = new Interface([
  'function owner() view returns (address)',
  'function isAdmin(address) view returns (bool)'
]);
export async function forgeSettingsAccess(
  config: DropForgeConfig,
  wallet: string | null
): Promise<{ can_edit: boolean; can_top_up: boolean }> {
  if (!wallet)
    throw new ForbiddenException('Drop Forge administrator access required');
  const includes = (values: string[]) =>
    values.some((value) => value.toLowerCase() === wallet.toLowerCase());
  if (includes(getClaimsAdminWallets()))
    return { can_edit: true, can_top_up: true };
  const provider = getEthereumRpcProvider(config.chainId);
  const owner = await rpcWithDeadline(
    provider.call({
      to: config.creator,
      data: accessAbi.encodeFunctionData('owner')
    })
  );
  if (
    String(accessAbi.decodeFunctionResult('owner', owner)[0]).toLowerCase() ===
    wallet.toLowerCase()
  )
    return { can_edit: true, can_top_up: true };
  if (includes(getDistributionAdminWallets()))
    return { can_edit: false, can_top_up: true };
  const admin = await rpcWithDeadline(
    provider.call({
      to: config.creator,
      data: accessAbi.encodeFunctionData('isAdmin', [wallet])
    })
  );
  if (accessAbi.decodeFunctionResult('isAdmin', admin)[0] === true)
    return { can_edit: false, can_top_up: true };
  throw new ForbiddenException('Drop Forge administrator access required');
}
