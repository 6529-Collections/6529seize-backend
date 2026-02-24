import { Contract, JsonRpcProvider } from 'ethers';
import { Logger } from '@/logging';
import { get6529RpcProvider, getRpcProvider } from '@/rpc-provider';
import { text } from '@/text';

const ENS_UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const ENS_ETH_COIN_TYPE = 60;
const ENS_UNIVERSAL_RESOLVER_ABI = [
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string primary, address resolver, address reverseResolver)'
] as const;

const logger = Logger.get('ENS_LOOKUP');
const ALCHEMY_PROVIDER_RETRY_COOLDOWN_MS = 60_000;
let alchemyUnavailableUntil = 0;

function getAlchemyProviderOrNull(): JsonRpcProvider | null {
  const now = Date.now();
  if (alchemyUnavailableUntil > now) {
    return null;
  }

  try {
    const provider = getRpcProvider();
    alchemyUnavailableUntil = 0;
    return provider;
  } catch (error: any) {
    alchemyUnavailableUntil = now + ALCHEMY_PROVIDER_RETRY_COOLDOWN_MS;
    logger.warn(
      `[ENS LOOKUP PROVIDER INIT FAILED] [PROVIDER alchemy] [COOLDOWN_MS ${ALCHEMY_PROVIDER_RETRY_COOLDOWN_MS}] [ERROR ${error}]`
    );
    return null;
  }
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

async function lookupPrimaryEnsNameVia6529(
  address: string
): Promise<string | null> {
  let rpc6529Provider: JsonRpcProvider;

  try {
    rpc6529Provider = get6529RpcProvider();
  } catch (error: any) {
    logger.warn(
      `[ENS LOOKUP PROVIDER INIT FAILED] [PROVIDER 6529] [ADDRESS ${address}] [ERROR ${error}]`
    );
    return null;
  }

  const ens = await lookupAddressWithProvider(rpc6529Provider, '6529', address);
  if (ens) {
    return ens;
  }

  return await findEnsViaUniversalResolver(rpc6529Provider, address);
}

export async function lookupPrimaryEnsName(
  address: string
): Promise<string | null> {
  const alchemyProvider = getAlchemyProviderOrNull();
  if (alchemyProvider) {
    const ens = await lookupAddressWithProvider(alchemyProvider, 'alchemy', address);
    if (ens) {
      return ens;
    }
  }

  return await lookupPrimaryEnsNameVia6529(address);
}

export async function findEnsForAddress(
  address: string
): Promise<string | null> {
  const ens = await lookupPrimaryEnsName(address);
  return ens ? text.replaceEmojisWithHex(ens) : null;
}
