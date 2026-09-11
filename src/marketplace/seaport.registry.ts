import { GRADIENT_CONTRACT, MEMES_CONTRACT } from '@/constants';
import { MarketValidationError } from '@/marketplace/provider.types';

export const MARKET_CHAIN_ID = 1;
export const MARKET_ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MARKET_ZERO_HASH = `0x${'0'.repeat(64)}`;
export const MARKET_WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const MARKET_SEAPORT = '0x0000000000000068f116a894984e2db1123eb395';
export const MARKET_NEXTGEN = '0x45882f9bc325e14fbb298a1df930c43a874b83ae';

// Verified against ProjectOpenSea/opensea-sdk src/constants.ts, 2026-09-10.
export const MARKET_OPENSEA_ZONE = '0x000056f7000000ece9003ca63978907a00ffd100';
export const MARKET_OPENSEA_CONDUIT_KEY =
  '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';
export const MARKET_OPENSEA_CONDUIT =
  '0x1e0049783f008a0085193e00003d00cd54003c71';

export const MARKET_ASSET_STANDARDS: Readonly<
  Record<string, 'ERC721' | 'ERC1155'>
> = Object.freeze({
  [MEMES_CONTRACT.toLowerCase()]: 'ERC1155',
  [GRADIENT_CONTRACT.toLowerCase()]: 'ERC721',
  [MARKET_NEXTGEN]: 'ERC721'
});

export function marketSpender(conduitKey: string): string {
  const key = conduitKey.toLowerCase();
  if (key === MARKET_ZERO_HASH) return MARKET_SEAPORT;
  if (key === MARKET_OPENSEA_CONDUIT_KEY) return MARKET_OPENSEA_CONDUIT;
  throw new MarketValidationError(
    'UNSUPPORTED_CONDUIT',
    'The order uses an unverified token operator.'
  );
}

export function assertMarketProtocol(address: string): void {
  if (address.toLowerCase() !== MARKET_SEAPORT) {
    throw new MarketValidationError(
      'UNSUPPORTED_PROTOCOL',
      'Only the verified Ethereum Seaport 1.6 deployment is supported.'
    );
  }
}
