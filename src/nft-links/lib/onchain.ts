import { Contract, formatUnits, JsonRpcProvider } from 'ethers';
import { externalIndexerRpc } from '@/external-indexing/external-indexer-rpc';

/**
 * Minimal onchain helpers.
 *
 * Repo preference is a shared, centralized RPC provider abstraction.
 * We bridge our historical ChainId ("eth") into the shared module's ChainKey.
 */

export function getProvider(chain: string): JsonRpcProvider {
  if (chain !== 'eth') {
    throw new Error(`Only eth chain is supported at the moment`);
  }
  return externalIndexerRpc.provider;
}

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

type Erc20Meta = { symbol: string; decimals: number };
const erc20Cache = new Map<string, Erc20Meta>();

export async function getErc20Meta(
  provider: JsonRpcProvider,
  tokenAddress: string
): Promise<Erc20Meta> {
  const addr = tokenAddress.toLowerCase();
  const cached = erc20Cache.get(addr);
  if (cached) return cached;

  const c = new Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);

  const parsedDecimals = Number(decimals);
  if (!Number.isFinite(parsedDecimals) || parsedDecimals < 0) {
    throw new Error(`Invalid ERC20 decimals for ${addr}: ${String(decimals)}`);
  }

  const meta: Erc20Meta = {
    symbol: String(symbol),
    decimals: parsedDecimals
  };
  erc20Cache.set(addr, meta);
  return meta;
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  try {
    return formatUnits(amount, decimals);
  } catch {
    return String(amount);
  }
}
