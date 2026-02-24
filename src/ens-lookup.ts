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

export async function lookupPrimaryEnsName(
  address: string
): Promise<string | null> {
  let ens: string | null = null;

  const alchemyProvider = getAlchemyProviderOrNull();
  if (alchemyProvider) {
    try {
      ens = await alchemyProvider.lookupAddress(address);
      if (ens) {
        logger.debug(
          `[ENS LOOKUP HIT] [PROVIDER alchemy] [ADDRESS ${address}] [ENS ${ens}]`
        );
      }
    } catch (error: any) {
      logger.debug(
        `[ENS LOOKUP FAILED] [PROVIDER alchemy] [ADDRESS ${address}] [ERROR ${error}]`
      );
      ens = null;
    }
  }

  if (!ens) {
    let rpc6529Provider: JsonRpcProvider | null = null;
    try {
      rpc6529Provider = get6529RpcProvider();
      ens = await rpc6529Provider.lookupAddress(address);
      if (ens) {
        logger.debug(
          `[ENS LOOKUP HIT] [PROVIDER 6529] [ADDRESS ${address}] [ENS ${ens}]`
        );
      }
    } catch (error: any) {
      logger.debug(
        `[ENS LOOKUP FAILED] [PROVIDER 6529] [ADDRESS ${address}] [ERROR ${error}]`
      );
      ens = null;
    }

    if (!ens && rpc6529Provider) {
      try {
        ens = await findEnsViaUniversalResolver(rpc6529Provider, address);
      } catch (error: any) {
        logger.debug(
          `[ENS LOOKUP FAILED] [PROVIDER universal-resolver] [ADDRESS ${address}] [ERROR ${error}]`
        );
        ens = null;
      }
    }
  }

  return ens;
}

export async function findEnsForAddress(
  address: string
): Promise<string | null> {
  const ens = await lookupPrimaryEnsName(address);
  return ens ? text.replaceEmojisWithHex(ens) : null;
}
