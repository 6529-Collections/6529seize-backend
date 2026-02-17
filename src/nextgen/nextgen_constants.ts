import { goerli, sepolia } from '@wagmi/chains';
import { Network } from 'alchemy-sdk';

export const NEXTGEN_BLOCKS_TABLE = 'nextgen_blocks';
export const NEXTGEN_LOGS_TABLE = 'nextgen_logs';
export const NEXTGEN_COLLECTIONS_TABLE = 'nextgen_collections';
export const NEXTGEN_TOKENS_TABLE = 'nextgen_tokens';
export const NEXTGEN_TOKEN_LISTINGS_TABLE = 'nextgen_token_listings';
export const NEXTGEN_ALLOWLIST_TABLE = 'nextgen_allowlist';
export const NEXTGEN_TOKEN_TRAITS_TABLE = 'nextgen_token_traits';
export const NEXTGEN_TOKEN_SCORES_TABLE = 'nextgen_token_scores';
export const NEXTGEN_ALLOWLIST_BURN_TABLE = 'nextgen_allowlist_burn';
export const NEXTGEN_ALLOWLIST_COLLECTIONS_TABLE =
  'nextgen_allowlist_collection';
export const NEXTGEN_BURN_COLLECTIONS_TABLE = 'nextgen_burn_collection';
export const NEXTGEN_TOKENS_TDH_TABLE = 'nextgen_tokens_tdh';

export const GENERATOR_BASE_PATH = 'https://generator.6529.io';
export const NEXTGEN_BUCKET = 'media.generator.6529.io';
export const NEXTGEN_CF_BASE_PATH = `https://${NEXTGEN_BUCKET}`;
export const NEXTGEN_BUCKET_AWS_REGION = 'us-east-1';
export const CLOUDFRONT_DISTRIBUTION = 'E1RI37JRN0ZK6J';

export const NEXTGEN_ROYALTIES_ADDRESS =
  '0xC8ed02aFEBD9aCB14c33B5330c803feacAF01377';

export const MINT_TYPE_TRAIT = 'Mint Type';

export type NextgenNetwork =
  | Network.ETH_MAINNET
  | Network.ETH_SEPOLIA
  | Network.ETH_GOERLI;

export function getNextgenNetwork(): NextgenNetwork {
  if (process.env.NEXTGEN_CHAIN_ID) {
    const chainId: number = parseInt(process.env.NEXTGEN_CHAIN_ID);
    if (chainId == sepolia.id) {
      return Network.ETH_SEPOLIA;
    }
    if (chainId == goerli.id) {
      return Network.ETH_GOERLI;
    }
  }
  return Network.ETH_MAINNET;
}

export const NEXTGEN_CORE_CONTRACT = {
  [Network.ETH_GOERLI]: '0x25a972f1bf3c816061ceaea59d2bb3fe4c130766',
  [Network.ETH_SEPOLIA]: '0x60671e59a349589Ad74bE6cd643003a0Abb38cC3',
  [Network.ETH_MAINNET]: '0x45882f9bc325E14FBb298a1Df930C43a874B83ae'
};

export const NEXTGEN_START_BLOCK = {
  [Network.ETH_GOERLI]: 10272665,
  [Network.ETH_SEPOLIA]: 5176112,
  [Network.ETH_MAINNET]: 19133749
};

export const NEXTGEN_MINTER_CONTRACT = {
  [Network.ETH_GOERLI]: '0x1a7040a7d4baf44f136c50626a4e8f4ae5ca170f',
  [Network.ETH_SEPOLIA]: '0xaDA9027EaF134038d3731f677241c4351b799Eb4',
  [Network.ETH_MAINNET]: '0x6113fd2c91514e84e6149c6ede47f2e09545253a'
};
