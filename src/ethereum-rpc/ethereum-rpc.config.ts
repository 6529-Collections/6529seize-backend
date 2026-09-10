const RPC_ENV_BY_CHAIN = {
  1: 'ETHEREUM_RPC_URL',
  5: 'ETHEREUM_GOERLI_RPC_URL',
  11155111: 'ETHEREUM_SEPOLIA_RPC_URL'
} as const;

/** Reject unsupported chains instead of silently routing them to mainnet. */
export function getEthereumRpcEnvName(chainId: number): string {
  if (chainId !== 1 && chainId !== 5 && chainId !== 11155111) {
    throw new Error(`Unsupported Ethereum RPC chain ID: ${chainId}`);
  }
  return RPC_ENV_BY_CHAIN[chainId];
}

/** Read after environment loading; errors must never contain RPC credentials. */
export function getEthereumRpcUrl(chainId: number = 1): string {
  const envName = getEthereumRpcEnvName(chainId);
  const value = process.env[envName];
  if (!value?.trim()) {
    throw new Error(`${envName} is required for Ethereum RPC chain ${chainId}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${envName} must be a complete HTTP(S) URL`);
  }

  // URL parsing normalizes malformed slashes and whitespace. Check the raw
  // value too, and disallow fragments because they are never sent to the RPC.
  if (
    !/^https?:\/\/[^/]/i.test(value) ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    !parsed.hostname ||
    /\s/.test(value) ||
    value.includes('\\') ||
    value.includes('#')
  ) {
    throw new Error(`${envName} must be a complete HTTP(S) URL`);
  }
  return value;
}
