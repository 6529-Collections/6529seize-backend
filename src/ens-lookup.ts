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
      ENS_ETH_COIN_TYPE
    );
    if (primaryName) {
      logger.debug(
        `[ENS LOOKUP HIT] [PROVIDER universal-resolver] [ADDRESS ${address}] [ENS ${primaryName}]`
      );
    }
    return primaryName || null;
  } catch (error: any) {
    logger.debug(
      `[ENS LOOKUP FAILED] [PROVIDER universal-resolver] [ADDRESS ${address}] [ERROR ${error}]`
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
  } catch (error: any) {
    logger.debug(
      `[ENS LOOKUP FAILED] [PROVIDER ${providerName}] [ADDRESS ${address}] [ERROR ${error}]`
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
