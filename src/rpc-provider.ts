import { Network, getRpcChainId } from '@/ethereum-rpc/ethereum-rpc-network';
import { getEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
export type SupportedRpcNetwork = Network;
export function getRpcProvider(
  network: SupportedRpcNetwork = Network.ETH_MAINNET
) {
  return getEthereumRpcProvider(getRpcChainId(network));
}
