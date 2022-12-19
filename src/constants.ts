import { Network } from 'alchemy-sdk';
const config = require('./config');

export const TDH_BLOCKS_TABLE = 'tdh_blocks';
export const TRANSACTIONS_TABLE = 'transactions';
export const TRANSACTIONS_REMAKE_TABLE = 'transactions_remake';
export const NFTS_TABLE = 'nfts';
export const ARTISTS_TABLE = 'artists';
export const OWNERS_TABLE = 'owners';
export const OWNERS_TAGS_TABLE = 'owners_tags';
export const MEMES_EXTENDED_DATA_TABLE = 'memes_extended_data';
export const WALLETS_TDH_TABLE = 'tdh';
export const ENS_TABLE = 'ens';

export const MEMES_CONTRACT = '0x33FD426905F149f8376e227d0C9D3340AaD17aF1';
export const GRADIENT_CONTRACT = '0x0c58ef43ff3032005e472cb5709f8908acb00205';
export const NULL_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MANIFOLD = '0x3A3548e060Be10c2614d0a4Cb0c03CC9093fD799';
export const PUNK_6529 = '0xfd22004806a6846ea67ad883356be810f0428793';
export const SIX529 = '0xB7d6ed1d7038BaB3634eE005FA37b925B11E9b13';
export const SIX529_ER = '0xE359aB04cEC41AC8C62bc5016C10C749c7De5480';
export const SIX529_COLLECTIONS = '0x4B76837F8D8Ad0A28590d06E53dCD44b6B7D4554';
export const SIX529_MUSEUM = '0xc6400A5584db71e41B0E5dFbdC769b54B91256CD';
export const ENS_ADDRESS = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';

export const ALCHEMY_SETTINGS = {
  apiKey: config.alchemy.ALCHEMY_API_KEY,
  network: Network.ETH_MAINNET,
  maxRetries: 10
};

export const INFURA_KEY = 'b496145d088a4fe5a5861a6db9ee2034';

export const NFT_ORIGINAL_IMAGE_LINK =
  'https://d3lqz0a4bldqgf.cloudfront.net/images/original/';

export const NFT_SCALED_IMAGE_LINK =
  'https://d3lqz0a4bldqgf.cloudfront.net/images/scaled_x450/';

export const NFT_VIDEO_LINK = 'https://d3lqz0a4bldqgf.cloudfront.net/videos/';
export const NFT_HTML_LINK = 'https://d3lqz0a4bldqgf.cloudfront.net/html/';
