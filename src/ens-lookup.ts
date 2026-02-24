import { Contract, JsonRpcProvider } from 'ethers';
import { get6529RpcProvider, getRpcProvider } from '@/rpc-provider';
import { text } from '@/text';

const ENS_UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const ENS_ETH_COIN_TYPE = 60;
const ENS_UNIVERSAL_RESOLVER_ABI = [
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string primary, address resolver, address reverseResolver)'
] as const;

let rpcAlchemy: JsonRpcProvider | null = null;
let rpc6529: JsonRpcProvider | null = null;
let alchemyUnavailable = false;

function getAlchemyProviderOrNull(): JsonRpcProvider | null {
  if (alchemyUnavailable) {
    return null;
  }
  if (!rpcAlchemy) {
    try {
      rpcAlchemy = getRpcProvider();
    } catch {
      alchemyUnavailable = true;
      return null;
    }
  }
  return rpcAlchemy;
}

function get6529Provider(): JsonRpcProvider {
  if (!rpc6529) {
    rpc6529 = get6529RpcProvider();
  }
  return rpc6529;
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
    return primaryName || null;
  } catch {
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
    } catch {
      ens = null;
    }
  }

  const rpc6529Provider = get6529Provider();
  if (!ens) {
    try {
      ens = await rpc6529Provider.lookupAddress(address);
    } catch {
      ens = null;
    }
  }
  if (!ens) {
    try {
      ens = await findEnsViaUniversalResolver(rpc6529Provider, address);
    } catch {
      ens = null;
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
