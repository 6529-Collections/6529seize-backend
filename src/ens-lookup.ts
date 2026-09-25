import { Contract, JsonRpcProvider } from 'ethers';
import { Logger } from '@/logging';
import { getRpcProvider } from '@/rpc-provider';
import { text } from '@/text';

const ENS_UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const ENS_ETH_COIN_TYPE = 60;
const ENS_UNIVERSAL_RESOLVER_ABI = [
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string primary, address resolver, address reverseResolver)'
] as const;

const logger = Logger.get('ENS_LOOKUP');
// Only fixed categories reach logs; provider messages and revert arguments may
// contain credentials, wallet addresses, ENS names or gateway URLs.
const ENS_REVERT_CATEGORIES = new Map([
  ['0x556f1830', 'OFFCHAIN_LOOKUP'],
  ['0x77209fe8', 'RESOLVER_NOT_FOUND'],
  ['0x1e9535f2', 'RESOLVER_NOT_CONTRACT'],
  ['0x7b1c461b', 'UNSUPPORTED_RESOLVER_PROFILE'],
  ['0x95c0c752', 'RESOLVER_ERROR'],
  ['0xef9c03ce', 'REVERSE_ADDRESS_MISMATCH'],
  ['0x01800152', 'GATEWAY_HTTP_ERROR']
]);
const ENS_ERROR_CODES = new Set([
  'CALL_EXCEPTION',
  'OFFCHAIN_FAULT',
  'TIMEOUT',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'BAD_DATA'
]);

function classifyEnsError(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return 'UNKNOWN';
  }
  if (
    error.code === 'CALL_EXCEPTION' &&
    'data' in error &&
    typeof error.data === 'string'
  ) {
    const category = ENS_REVERT_CATEGORIES.get(
      error.data.slice(0, 10).toLowerCase()
    );
    if (category) return category;
  }
  return typeof error.code === 'string' && ENS_ERROR_CODES.has(error.code)
    ? error.code
    : 'UNKNOWN';
}

async function findEnsViaUniversalResolver(
  provider: JsonRpcProvider,
  address: string
): Promise<string | null> {
  const universalResolver = new Contract(
    ENS_UNIVERSAL_RESOLVER,
    ENS_UNIVERSAL_RESOLVER_ABI,
    provider
  );

  try {
    const [primaryName] = await universalResolver.reverse(
      address,
      ENS_ETH_COIN_TYPE,
      { enableCcipRead: true }
    );
    logger.info(
      `[ENS_UNIVERSAL_RESOLVER] [OUTCOME=${primaryName ? 'hit' : 'miss'}]`
    );
    return primaryName || null;
  } catch (error: unknown) {
    // Stable outcomes can be counted without logging wallets or RPC credentials.
    logger.info(
      `[ENS_UNIVERSAL_RESOLVER] [OUTCOME=error] [CATEGORY=${classifyEnsError(error)}]`
    );
    return null;
  }
}

async function lookupAddressWithProvider(
  provider: JsonRpcProvider,
  providerName: string,
  address: string
): Promise<string | null> {
  try {
    const ens = await provider.lookupAddress(address);
    if (ens) {
      logger.debug(
        `[ENS LOOKUP HIT] [PROVIDER ${providerName}] [ADDRESS ${address}] [ENS ${ens}]`
      );
    }
    return ens;
  } catch (error: unknown) {
    logger.debug(
      `[ENS LOOKUP FAILED] [PROVIDER ${providerName}] [CATEGORY=${classifyEnsError(error)}]`
    );
    return null;
  }
}

export async function lookupPrimaryEnsName(
  address: string
): Promise<string | null> {
  // Configuration errors fail explicitly. Lookup misses/errors retain the
  // Universal Resolver fallback, but both reads use the configured provider.
  const provider = getRpcProvider();
  const ens = await lookupAddressWithProvider(
    provider,
    'ethereum-rpc',
    address
  );
  return ens ?? (await findEnsViaUniversalResolver(provider, address));
}

export async function findEnsForAddress(
  address: string
): Promise<string | null> {
  const ens = await lookupPrimaryEnsName(address);
  return ens ? text.replaceEmojisWithHex(ens) : null;
}
