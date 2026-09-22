export enum Network {
  ETH_MAINNET = 'eth-mainnet',
  ETH_SEPOLIA = 'eth-sepolia',
  ETH_GOERLI = 'eth-goerli'
}

/** Chain selection is explicit; unsupported networks never fall back to mainnet. */
export function getRpcChainId(network: Network): number {
  switch (network) {
    case Network.ETH_MAINNET:
      return 1;
    case Network.ETH_SEPOLIA:
      return 11155111;
    case Network.ETH_GOERLI:
      return 5;
    default:
      throw new Error('Unsupported Ethereum RPC network');
  }
}
